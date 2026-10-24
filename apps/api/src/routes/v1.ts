import type { SessionTimeline, TimelineSession } from "@fleetscope/db";
import { SessionId } from "@fleetscope/schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { buildTrace } from "../trace/build-trace";
import { errorPage, PAGE_CONTENT_SECURITY_POLICY, perfettoPage } from "../trace/perfetto-page";

export interface V1RouteOptions {
  /** The timeline of one session, or null when there is no such session. */
  getSessionTimeline?: (sessionId: string) => Promise<SessionTimeline | null>;
  /** Just the session row (for the Perfetto page, which does not need the whole timeline). */
  getSession?: (sessionId: string) => Promise<TimelineSession | null>;
}

/**
 * Everything under /v1 that is registered with the prefix. The dashboards read ClickHouse
 * themselves (Grafana, docs/adr/0003-grafana-dashboards.md), so the API has no query routes for them; what it
 * adds is the session timeline for Perfetto. `POST /v1/events` is registered in routes/events.ts
 * with the full path from `INGEST_PATH`, so the collector and the API share one constant.
 *
 *   GET /v1/sessions/:id/trace     200 Chrome Trace Event JSON | 400 bad id | 404 | 500
 *   GET /v1/sessions/:id/perfetto  200 HTML page that opens the trace in ui.perfetto.dev | 400 | 404 | 500
 *
 * Both answer `cache-control: no-store`: a running session changes, and an error must not be cached.
 */
export const v1Routes: FastifyPluginAsync<V1RouteOptions> = async (app, options) => {
  const { getSessionTimeline, getSession } = options;

  if (getSessionTimeline) {
    app.get<{ Params: { id: string } }>("/sessions/:id/trace", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const id = SessionId.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: "invalid session id" });
      try {
        const timeline = await getSessionTimeline(id.data);
        if (!timeline) return reply.code(404).send({ error: "session not found" });
        return reply.type("application/json; charset=utf-8").send(buildTrace(timeline));
      } catch (error) {
        request.log.error({ err: error, sessionId: id.data }, "building the session trace failed");
        return reply.code(500).send({ error: "internal error" });
      }
    });
  }

  if (getSession) {
    app.get<{ Params: { id: string } }>("/sessions/:id/perfetto", async (request, reply) => {
      const id = SessionId.safeParse(request.params.id);
      if (!id.success)
        return html(reply, 400, errorPage("Bad session id", "That is not a valid session id."));
      try {
        const session = await getSession(id.data);
        if (!session) {
          return html(
            reply,
            404,
            errorPage("Session not found", `There is no session with the id ${clipId(id.data)}.`),
          );
        }
        return html(reply, 200, perfettoPage(session));
      } catch (error) {
        request.log.error({ err: error, sessionId: id.data }, "the Perfetto page failed");
        return html(
          reply,
          500,
          errorPage("Something went wrong", "The session could not be loaded. Try again."),
        );
      }
    });
  }
};

/** An id can be long and hostile; the error page shows at most the first 80 characters (escaped there). */
function clipId(id: string): string {
  return id.length > 80 ? `${id.slice(0, 80)}...` : id;
}

function html(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .header("content-security-policy", PAGE_CONTENT_SECURITY_POLICY)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .type("text/html; charset=utf-8")
    .send(page);
}
