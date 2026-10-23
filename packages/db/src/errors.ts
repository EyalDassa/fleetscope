import { ClickHouseError } from "./client";

/**
 * Can a failed INSERT succeed if the same rows are sent again?
 *  - "transient": yes, sooner or later. The server or the network is the problem: connection
 *    refused or reset, timeouts, memory limits, too many queries, a restart, merges falling behind.
 *  - "data": no. The server understood the request and refuses these rows, and will refuse them
 *    every time (a value that cannot be parsed or stored).
 *
 * The ingest buffer retries transient errors forever and gives up on a flush only after it has
 * failed with a data error several times in a row (docs/adr/0002-ingest-dedupe.md).
 *
 * The list of data errors is deliberately short. An error we do not know counts as transient: a
 * visible stall that keeps the data is better than dropping it. In particular a missing table or
 * database (migrations not run) is NOT a data error: it is fixed by the operator, not by
 * changing the rows.
 */
export type InsertErrorKind = "transient" | "data";

/** ClickHouse error codes (system.errors) that a given set of rows will always produce. */
const DATA_ERROR_CODES: ReadonlySet<string> = new Set([
  "6", //   CANNOT_PARSE_TEXT
  "25", //  CANNOT_PARSE_ESCAPE_SEQUENCE (a lone UTF-16 surrogate in a JSON string)
  "26", //  CANNOT_PARSE_QUOTED_STRING
  "27", //  CANNOT_PARSE_INPUT_ASSERTION_FAILED
  "38", //  CANNOT_PARSE_DATE
  "41", //  CANNOT_PARSE_DATETIME
  "53", //  TYPE_MISMATCH
  "70", //  CANNOT_CONVERT_TYPE
  "72", //  CANNOT_PARSE_NUMBER
  "117", // INCORRECT_DATA
  "131", // TOO_LARGE_STRING_SIZE
  "321", // VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE
  "376", // CANNOT_PARSE_UUID
]);

const TOO_MANY_PARTS = "252";

export function classifyInsertError(error: unknown): InsertErrorKind {
  // Anything that is not an answer from the server (ECONNREFUSED, ECONNRESET, a timeout, an
  // aborted request, a bare HTTP 502) is the network's or the server's problem.
  if (!(error instanceof ClickHouseError)) return "transient";
  if (DATA_ERROR_CODES.has(error.code)) return "data";
  // TOO_MANY_PARTS has two causes. "Too many partitions for single INSERT block" (more than
  // max_partitions_per_insert_block = 100 days in one flush) depends on the rows. "Too many parts
  // ... merges are slower than inserts" is back-pressure that goes away by itself.
  if (error.code === TOO_MANY_PARTS && /too many partitions/i.test(error.message)) return "data";
  return "transient";
}
