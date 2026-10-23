import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type EventEnvelope, FleetEvent, newEvent } from "@fleetscope/schema";
import { afterEach, describe, expect, it } from "vitest";
import { fileDeadLetter } from "./dead-letter";

const ctx: EventEnvelope = {
  session_id: "s1",
  source: "real",
  agent_id: "agent-1",
  engine: "chromium",
  provider: "local-docker",
};
const issue = (message: string) => newEvent("issue", ctx, { kind: "crash", message });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fleetscope-deadletter-"));
  dirs.push(dir);
  return dir;
}

describe("fileDeadLetter", () => {
  it("writes one JSONL file per flush, one event per line, and returns its absolute path", async () => {
    const dir = await tempDir();
    const events = [issue("one"), issue("two\nlines"), issue("três 日本語")];
    const path = await fileDeadLetter(dir, () => Date.UTC(2026, 9, 23, 12, 34, 56, 789))(
      "flush-abc",
      events,
    );

    expect(isAbsolute(path)).toBe(true);
    expect(path.endsWith("2026-10-23T12-34-56-789Z-flush-abc.jsonl")).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    // each line is a whole, valid event: it can be sent to POST /v1/events again
    expect(lines.map((line) => FleetEvent.parse(JSON.parse(line)))).toEqual(events);
  });

  it("creates the directory, including parents", async () => {
    const dir = join(await tempDir(), "a", "b", "deadletter");
    const path = await fileDeadLetter(dir)("f1", [issue("x")]);
    expect((await readdir(dir)).length).toBe(1);
    expect(path.startsWith(dir) || path.includes("deadletter")).toBe(true);
  });

  it("leaves no temporary file behind, and keeps flushes apart", async () => {
    const dir = await tempDir();
    const save = fileDeadLetter(dir);
    await save("f1", [issue("a")]);
    await save("f2", [issue("b")]);
    const names = (await readdir(dir)).sort();
    expect(names).toHaveLength(2);
    expect(names.every((name) => name.endsWith(".jsonl"))).toBe(true);
  });

  it("rejects when the file cannot be written, so the buffer keeps the events", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    await expect(fileDeadLetter(join(blocker, "sub"))("f1", [issue("x")])).rejects.toThrow();
  });
});
