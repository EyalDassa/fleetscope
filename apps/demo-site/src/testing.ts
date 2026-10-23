/** Helpers shared by the tests. Not imported by the server. */
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "./app";

export interface TestApp {
  app: FastifyInstance;
  /** Every `ms` that a page asked to wait, in order. The tests never really wait. */
  sleeps: number[];
}

export async function makeApp(): Promise<TestApp> {
  const sleeps: number[] = [];
  const app = await buildApp({
    logLevel: false,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { app, sleeps };
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function get(app: FastifyInstance, url: string, cookie?: string) {
  return app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
}

export function post(
  app: FastifyInstance,
  url: string,
  fields: Record<string, string>,
  cookie?: string,
) {
  return app.inject({
    method: "POST",
    url,
    payload: formBody(fields),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
  });
}

/** The "name=value" part of the first Set-Cookie header, ready to send back as `cookie`. */
export function cookieFrom(response: LightMyRequestResponse): string | undefined {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  return first?.split(";")[0];
}

/** Signs in as the demo user and returns the session cookie. */
export async function login(app: FastifyInstance): Promise<string> {
  const response = await post(app, "/login", { user: "agent", pass: "fleetscope" });
  const cookie = cookieFrom(response);
  if (!cookie) throw new Error("login did not set a cookie");
  return cookie;
}

export function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
