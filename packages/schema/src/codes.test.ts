import { describe, expect, it } from "vitest";
import { ERROR_CODES, ISSUE_FOR_CODE } from "./codes";
import { ISSUE_KINDS } from "./events";

describe("error codes", () => {
  it("every code maps to an issue kind or null, and nothing else is mapped", () => {
    expect(Object.keys(ISSUE_FOR_CODE).sort()).toEqual([...ERROR_CODES].sort());
    for (const kind of Object.values(ISSUE_FOR_CODE)) {
      if (kind !== null) expect(ISSUE_KINDS).toContain(kind);
    }
  });

  it("every code is a safe label (error_code is put into SQL by the dashboards)", () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Za-z0-9._:@/+-]{1,128}$/);
  });
});

describe("site_layout (docs/adr/0007)", () => {
  it("is an error code that raises no issue: the site changed, not the browser", () => {
    expect(ERROR_CODES).toContain("site_layout");
    expect(ISSUE_FOR_CODE.site_layout).toBeNull();
  });
});

describe("http_429", () => {
  it("is its own code and raises a blocked issue, like http_403", () => {
    expect(ERROR_CODES).toContain("http_429");
    expect(ISSUE_FOR_CODE.http_429).toBe("blocked");
    expect(ISSUE_FOR_CODE.http_429).toBe(ISSUE_FOR_CODE.http_403);
  });
});
