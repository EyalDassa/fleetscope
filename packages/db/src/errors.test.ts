import { describe, expect, it } from "vitest";
import { ClickHouseError } from "./client";
import { classifyInsertError } from "./errors";

const server = (code: string, message = "boom", type?: string) =>
  new ClickHouseError({ message, code, type });

describe("classifyInsertError", () => {
  it.each([
    ["6", "CANNOT_PARSE_TEXT"],
    ["25", "CANNOT_PARSE_ESCAPE_SEQUENCE"],
    ["26", "CANNOT_PARSE_QUOTED_STRING"],
    ["27", "CANNOT_PARSE_INPUT_ASSERTION_FAILED"],
    ["38", "CANNOT_PARSE_DATE"],
    ["41", "CANNOT_PARSE_DATETIME"],
    ["53", "TYPE_MISMATCH"],
    ["70", "CANNOT_CONVERT_TYPE"],
    ["72", "CANNOT_PARSE_NUMBER"],
    ["117", "INCORRECT_DATA"],
    ["131", "TOO_LARGE_STRING_SIZE"],
    ["321", "VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE"],
    ["376", "CANNOT_PARSE_UUID"],
  ])("code %s (%s) is a data error", (code, type) => {
    expect(classifyInsertError(server(code, "bad row", type))).toBe("data");
  });

  it("treats too many partitions in one INSERT as a data error", () => {
    const error = server(
      "252",
      "Too many partitions for single INSERT block (more than 100). The limit is controlled by 'max_partitions_per_insert_block' setting.",
      "TOO_MANY_PARTS",
    );
    expect(classifyInsertError(error)).toBe("data");
  });

  it("treats too many parts (merges falling behind) as transient", () => {
    const error = server(
      "252",
      "Too many parts (3001) in all partitions in total in table 'db.actions'. Merges are processing significantly slower than inserts.",
      "TOO_MANY_PARTS",
    );
    expect(classifyInsertError(error)).toBe("transient");
  });

  it.each([
    ["202", "TOO_MANY_SIMULTANEOUS_QUERIES"],
    ["241", "MEMORY_LIMIT_EXCEEDED"],
    ["159", "TIMEOUT_EXCEEDED"],
    ["209", "SOCKET_TIMEOUT"],
    ["210", "NETWORK_ERROR"],
    ["243", "NOT_ENOUGH_SPACE"],
    ["319", "UNKNOWN_STATUS_OF_INSERT"],
    // the operator fixes these (run the migrations), changing the rows would not help
    ["60", "UNKNOWN_TABLE"],
    ["81", "UNKNOWN_DATABASE"],
    ["47", "UNKNOWN_IDENTIFIER"],
    ["516", "AUTHENTICATION_FAILED"],
    ["999", "SOMETHING_NEW"],
  ])("code %s (%s) is transient", (code, type) => {
    expect(classifyInsertError(server(code, "nope", type))).toBe("transient");
  });

  it("treats errors that are not answers from the server as transient", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8123"), {
      code: "ECONNREFUSED",
    });
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(classifyInsertError(refused)).toBe("transient");
    expect(classifyInsertError(reset)).toBe("transient");
    expect(classifyInsertError(new Error("Timeout error."))).toBe("transient");
    expect(classifyInsertError(new DOMException("aborted", "AbortError"))).toBe("transient");
    expect(classifyInsertError("a string")).toBe("transient");
    expect(classifyInsertError(undefined)).toBe("transient");
  });

  it("does not trust a plain object that only looks like a ClickHouse error", () => {
    expect(classifyInsertError({ code: "25", message: "x" })).toBe("transient");
  });
});
