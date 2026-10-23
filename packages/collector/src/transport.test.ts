import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type FleetEvent, newEvent } from "@fleetscope/schema";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "./test-utils";
import { createHttpTransport, parseRetryAfter } from "./transport";

const envelope = {
  session_id: "s1",
  source: "real",
  agent_id: "a1",
  engine: "chromium",
  provider: "local-docker",
} as const;

function events(n = 2): FleetEvent[] {
  return Array.from({ length: n }, (_, i) =>
    newEvent("action", envelope, {
      seq: i,
      action_type: "goto",
      target: "example.com",
      duration_ms: 10,
      ok: true,
      error_code: null,
    }),
  );
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, call: number) => void;

let server: Server | undefined;

/** A fake API: `handler` decides the answer, `requests` records what it received. */
async function fakeApi(handler: Handler) {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const created = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      handler(req, res, body, requests.length);
    });
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const { port } = created.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}`, requests };
}

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (!closing) return;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

const fast = { baseDelayMs: 1, maxDelayMs: 2, logger: silentLogger };

describe("http transport", () => {
  it("POSTs the batch as JSON to /v1/events and reads the 202 answer", async () => {
    const api = await fakeApi((_req, res) => reply(res, 202, { accepted: 2, duplicates: 0 }));
    const batch = events(2);
    const result = await createHttpTransport({ apiUrl: api.apiUrl, ...fast }).send(batch);

    expect(result).toEqual({ status: "accepted", accepted: 2, duplicates: 0 });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.method).toBe("POST");
    expect(api.requests[0]?.url).toBe("/v1/events");
    expect(JSON.parse(api.requests[0]?.body ?? "")).toEqual(JSON.parse(JSON.stringify(batch)));
  });

  it("reports duplicates from the answer", async () => {
    const api = await fakeApi((_req, res) => reply(res, 202, { accepted: 1, duplicates: 1 }));
    const result = await createHttpTransport({ apiUrl: api.apiUrl, ...fast }).send(events(2));
    expect(result).toEqual({ status: "accepted", accepted: 1, duplicates: 1 });
  });

  it("retries a 503, sends the same events again, and succeeds", async () => {
    const api = await fakeApi((_req, res, _body, call) =>
      call < 3
        ? reply(res, 503, { error: "buffer full" })
        : reply(res, 202, { accepted: 2, duplicates: 0 }),
    );
    const result = await createHttpTransport({ apiUrl: api.apiUrl, ...fast }).send(events(2));

    expect(result.status).toBe("accepted");
    expect(api.requests).toHaveLength(3);
    const bodies = new Set(api.requests.map((r) => r.body));
    expect(bodies.size).toBe(1); // identical event_ids on every try, so the API can drop repeats
  });

  it("waits for Retry-After on a 503", async () => {
    const api = await fakeApi((_req, res, _body, call) =>
      call === 1
        ? reply(res, 503, { error: "buffer full" }, { "retry-after": "2" })
        : reply(res, 202, { accepted: 1, duplicates: 0 }),
    );
    const sleeps: number[] = [];
    const result = await createHttpTransport({
      apiUrl: api.apiUrl,
      ...fast,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).send(events(1));

    expect(result.status).toBe("accepted");
    expect(sleeps).toEqual([2000]);
  });

  it("caps an absurd Retry-After", async () => {
    const api = await fakeApi((_req, res, _body, call) =>
      call === 1
        ? reply(res, 503, { error: "x" }, { "retry-after": "86400" })
        : reply(res, 202, { accepted: 1, duplicates: 0 }),
    );
    const sleeps: number[] = [];
    await createHttpTransport({
      apiUrl: api.apiUrl,
      ...fast,
      maxRetryAfterMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).send(events(1));
    expect(sleeps).toEqual([5000]);
  });

  it("retries a 500 with jittered exponential backoff", async () => {
    const api = await fakeApi((_req, res, _body, call) =>
      call < 4
        ? reply(res, 500, { error: "boom" })
        : reply(res, 202, { accepted: 1, duplicates: 0 }),
    );
    const sleeps: number[] = [];
    const result = await createHttpTransport({
      apiUrl: api.apiUrl,
      logger: silentLogger,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 1, // top of the jitter range
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).send(events(1));

    expect(result.status).toBe("accepted");
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("jitter keeps the delay between half and full of the exponential step", async () => {
    const api = await fakeApi((_req, res) => reply(res, 500, { error: "boom" }));
    const sleeps: number[] = [];
    await createHttpTransport({
      apiUrl: api.apiUrl,
      logger: silentLogger,
      maxAttempts: 2,
      baseDelayMs: 100,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).send(events(1));
    expect(sleeps).toEqual([50]);
  });

  it("does not retry a 400 and passes the issues back", async () => {
    const issues = [{ path: [0, "ts"], message: "too far in the future" }];
    const api = await fakeApi((_req, res) => reply(res, 400, { error: "invalid body", issues }));
    const result = await createHttpTransport({ apiUrl: api.apiUrl, ...fast }).send(events(1));

    expect(result).toEqual({ status: "rejected", httpStatus: 400, error: "invalid body", issues });
    expect(api.requests).toHaveLength(1);
  });

  it("does not retry a 413", async () => {
    const api = await fakeApi((_req, res) => reply(res, 413, { error: "too many events" }));
    const result = await createHttpTransport({ apiUrl: api.apiUrl, ...fast }).send(events(1));
    expect(result).toMatchObject({ status: "rejected", httpStatus: 413 });
    expect(api.requests).toHaveLength(1);
  });

  it("copes with a 4xx whose body is not our error shape", async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    const result = await createHttpTransport({ apiUrl: api.apiUrl, ...fast }).send(events(1));
    expect(result).toMatchObject({ status: "rejected", httpStatus: 404, error: "nope" });
  });

  it("gives up after maxAttempts and says so", async () => {
    const api = await fakeApi((_req, res) => reply(res, 503, { error: "buffer full" }));
    const result = await createHttpTransport({
      apiUrl: api.apiUrl,
      ...fast,
      maxAttempts: 3,
    }).send(events(1));

    expect(result.status).toBe("failed");
    expect(api.requests).toHaveLength(3);
  });

  it("retries network errors (nothing listening), then fails", async () => {
    const sleeps: number[] = [];
    const result = await createHttpTransport({
      apiUrl: "http://127.0.0.1:1",
      logger: silentLogger,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).send(events(1));

    expect(result.status).toBe("failed");
    expect(sleeps).toHaveLength(2);
  });

  it("stops retrying when aborted", async () => {
    const api = await fakeApi((_req, res) => reply(res, 503, { error: "buffer full" }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await createHttpTransport({
      apiUrl: api.apiUrl,
      logger: silentLogger,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
    }).send(events(1), { signal: controller.signal });

    expect(result.status).toBe("failed");
    expect(api.requests).toHaveLength(1);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, and ignores garbage", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.UTC(2026, 9, 23, 12, 0, 0);
    expect(parseRetryAfter("Fri, 23 Oct 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Fri, 23 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });
});
