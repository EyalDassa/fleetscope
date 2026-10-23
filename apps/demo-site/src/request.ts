import type { FastifyRequest } from "fastify";
import { readCookie, SESSION_COOKIE, type Session } from "./session";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in session, set by the requireLogin hook on protected routes. */
    session: Session | null;
  }
}

/** A string query parameter (the first one if it is repeated), or "" when absent. */
export function queryString(request: FastifyRequest, name: string): string {
  const value = (request.query as Record<string, unknown> | undefined)?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : "";
}

/** A text field from a urlencoded form body, or "" when absent. */
export function formField(request: FastifyRequest, name: string): string {
  const body = request.body;
  return body instanceof URLSearchParams ? (body.get(name) ?? "") : "";
}

export function sessionIdFromRequest(request: FastifyRequest): string | undefined {
  return readCookie(request.headers.cookie, SESSION_COOKIE);
}
