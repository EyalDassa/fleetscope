/**
 * Who may call /admin/*: only a process on the same machine as the demo site.
 *
 * The site binds 0.0.0.0 (browser containers must reach it), so anyone on the same network could
 * otherwise switch chaos on during a demo. Browser containers never need the admin API; people
 * and tests on the host do, and they connect from loopback.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

/**
 * onRequest hook that answers 403 to anyone who is not on loopback.
 *
 * It reads the address of the TCP connection itself, never `request.ip` or the X-Forwarded-For
 * header, which the caller can set to anything. A missing address counts as "not loopback".
 */
export async function requireLoopback(request: FastifyRequest, reply: FastifyReply) {
  if (isLoopbackAddress(request.raw.socket.remoteAddress)) return;
  request.log.warn({ remoteAddress: request.raw.socket.remoteAddress }, "admin request refused");
  return reply.code(403).send({
    error: "forbidden",
    message: "The admin API only accepts requests from the machine the demo site runs on.",
  });
}
