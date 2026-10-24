import { createHash } from "node:crypto";
import type { TimelineSession } from "@fleetscope/db";

/**
 * The page at `GET /v1/sessions/:id/perfetto`. It opens the Perfetto UI in a new tab and hands it the
 * session's trace with `postMessage`, the way https://perfetto.dev/docs/visualization/deep-linking-to-perfetto-ui
 * describes:
 *
 *   1. fetch `./trace` as soon as the page loads, so the click does not wait for the network
 *      (a browser only allows `window.open` shortly after a user gesture);
 *   2. on click: `window.open('https://ui.perfetto.dev')`, then send 'PING' every 50 ms until the
 *      window answers 'PONG' (a message sent before the UI listens is lost);
 *   3. post `{ perfetto: { buffer, title, fileName } }`.
 *
 * The page is a string because the API is an esbuild bundle: there are no static files next to it.
 * There are no external scripts. The one inline script is static (everything that varies per session
 * goes in escaped `data-` attributes), so the Content-Security-Policy can allow exactly that script
 * by its hash.
 */

export const PERFETTO_ORIGIN = "https://ui.perfetto.dev";

/** The page's one script. Exported so a test can run it against a fake `window`. */
export const PERFETTO_PAGE_SCRIPT = `(function () {
  var PERFETTO = ${JSON.stringify(PERFETTO_ORIGIN)};
  var app = document.getElementById('app');
  var button = document.getElementById('open');
  var message = document.getElementById('message');
  var buffer = null;

  function say(text, isError) {
    message.textContent = text;
    message.className = isError ? 'error' : '';
  }

  fetch('./trace', { headers: { accept: 'application/json' } })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.arrayBuffer();
    })
    .then(function (bytes) {
      buffer = bytes;
      button.disabled = false;
      say('Trace ready (' + Math.max(1, Math.round(bytes.byteLength / 1024)) + ' KiB).');
    })
    .catch(function (error) {
      say('Could not load the trace: ' + error.message, true);
    });

  button.addEventListener('click', function () {
    if (!buffer) return;
    var win = window.open(PERFETTO);
    if (!win) {
      say('The browser blocked the new tab. Allow pop-ups for this site and click the button again.', true);
      return;
    }
    say('Waiting for Perfetto to start...');
    var ping = setInterval(function () {
      if (win.closed) return stop();
      win.postMessage('PING', PERFETTO);
    }, 50);
    var giveUp = setTimeout(function () {
      stop();
      say('Perfetto did not answer. Close the tab and try again.', true);
    }, 30000);
    function stop() {
      clearInterval(ping);
      clearTimeout(giveUp);
      window.removeEventListener('message', onMessage);
    }
    function onMessage(event) {
      if (event.origin !== PERFETTO || event.data !== 'PONG') return;
      stop();
      win.postMessage(
        { perfetto: { buffer: buffer, title: app.dataset.title, fileName: app.dataset.fileName } },
        PERFETTO
      );
      say('Sent to Perfetto. If it asks whether to trust this origin, answer yes.');
    }
    window.addEventListener('message', onMessage);
  });
})();`;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; }
  main { max-width: 38rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0 0 1.5rem; }
  dt { opacity: .7; }
  dd { margin: 0; word-break: break-all; }
  button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
  button:disabled { cursor: default; }
  a { margin-left: 1rem; }
  p { margin: 1rem 0 0; }
  .error { color: #b00020; }
  @media (prefers-color-scheme: dark) { .error { color: #ff8a80; } }
  .note { opacity: .7; font-size: .9rem; }
`;

const sha256 = (text: string): string =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/**
 * Locks the page down: nothing loads except the one inline script and style (by hash), the only
 * request it may make is to its own origin (`./trace`), and it cannot be framed.
 */
export const PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src ${sha256(PERFETTO_PAGE_SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Everything in a session id or a label that could break out of HTML text or an attribute. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A file name made of safe characters only, whatever the session id contains. */
export function traceFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `fleetscope-${safe}.json`;
}

function shell(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
${script}
</body>
</html>
`;
}

/** The page for an existing session. */
export function perfettoPage(session: TimelineSession): string {
  const title = `Fleetscope session ${session.session_id} (${session.engine}, ${session.scenario})`;
  const fileName = traceFileName(session.session_id);
  const rows: Array<[string, string]> = [
    ["Session", session.session_id],
    ["Status", session.reason ? `${session.status} (${session.reason})` : session.status],
    [
      "Engine",
      session.engine_version ? `${session.engine} ${session.engine_version}` : session.engine,
    ],
    ["Scenario", session.scenario],
    ["Source", session.source === "sim" ? "SIM (simulated)" : "REAL"],
    ["Started", new Date(session.started_at_ms).toISOString()],
  ];
  const list = rows
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("\n    ");
  return shell(
    `Session ${session.session_id} in Perfetto`,
    `<main id="app" data-title="${escapeHtml(title)}" data-file-name="${escapeHtml(fileName)}">
  <h1>Session timeline</h1>
  <dl>
    ${list}
  </dl>
  <button id="open" type="button" disabled>Open in Perfetto</button>
  <a id="download" href="./trace" download="${escapeHtml(fileName)}">Download trace</a>
  <p id="message" role="status">Loading the trace...</p>
  <p class="note">Opens ui.perfetto.dev in a new tab. The trace goes straight from this page to that tab and is processed in your browser; it is not uploaded anywhere.</p>
</main>`,
    `<script>${PERFETTO_PAGE_SCRIPT}</script>`,
  );
}

/** A plain page for an error (404 unknown session, 400 bad id, 500). The detail is escaped. */
export function errorPage(heading: string, detail: string): string {
  return shell(
    heading,
    `<main>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(detail)}</p>
</main>`,
  );
}
