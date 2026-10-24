import { describe, expect, it } from "vitest";
import { assertReadQuery, ClickHouseQueryError, runQuery } from "./clickhouse-http";
import { testPassword } from "./test-fixtures";

const connection = {
  url: "http://ch.test:8123",
  user: "grafana_ro",
  password: testPassword(),
  database: "fleetscope",
};

describe("assertReadQuery", () => {
  it("accepts SELECT and WITH, after comments and whitespace", () => {
    expect(() => assertReadQuery("SELECT 1")).not.toThrow();
    expect(() =>
      assertReadQuery("  -- note\n  with x as (select 1) select * from x"),
    ).not.toThrow();
    expect(() => assertReadQuery("/* c */ select 1")).not.toThrow();
  });

  it("rejects everything else", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "DROP TABLE t",
      "ALTER TABLE t DELETE WHERE 1",
      "",
      "  ",
    ]) {
      expect(() => assertReadQuery(sql)).toThrow(ClickHouseQueryError);
    }
  });
});

describe("runQuery", () => {
  it("sends the SQL with the user, password and database, and parses JSONCompact", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      });
      return new Response(JSON.stringify({ meta: [{ name: "n" }], data: [[1], [2]] }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await runQuery(connection, "SELECT n FROM t;\n", fetchImpl);

    expect(result).toEqual({ columns: ["n"], rows: [[1], [2]] });
    const request = seen[0];
    expect(request?.url).toContain("database=fleetscope");
    expect(request?.url).toContain("default_format=JSONCompact");
    expect(request?.headers["X-ClickHouse-User"]).toBe("grafana_ro");
    expect(request?.headers["X-ClickHouse-Key"]).toBe(connection.password);
    expect(request?.body).toBe("SELECT n FROM t"); // the trailing semicolon is removed
    expect(request?.url).not.toContain(connection.password);
  });

  it("turns a ClickHouse error into ClickHouseQueryError with the server's message", async () => {
    const fetchImpl = (async () =>
      new Response("Code: 47. DB::Exception: Unknown identifier `nope`. (UNKNOWN_IDENTIFIER)\n", {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(runQuery(connection, "SELECT nope", fetchImpl)).rejects.toMatchObject({
      name: "ClickHouseQueryError",
      status: 404,
      message: expect.stringContaining("Code: 47"),
    });
  });

  it("explains a connection failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(runQuery(connection, "SELECT 1", fetchImpl)).rejects.toThrow(
      /cannot reach ClickHouse at http:\/\/ch\.test:8123/,
    );
  });

  it("does not send a write query at all", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(runQuery(connection, "DROP TABLE sessions", fetchImpl)).rejects.toThrow(
      /SELECT or WITH/,
    );
    expect(called).toBe(false);
  });

  it("copes with a query that has its own FORMAT clause", async () => {
    const fetchImpl = (async () =>
      new Response("1\t2\n", { status: 200 })) as unknown as typeof fetch;
    expect(await runQuery(connection, "SELECT 1, 2 FORMAT TSV", fetchImpl)).toEqual({
      columns: [],
      rows: [],
    });
  });
});
