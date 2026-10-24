// Does a browser image actually run Web Workers? (ADR 0005)
//
//   node tools/worker-probe.mjs lightpanda/browser:1.0.2
//   node tools/worker-probe.mjs chromedp/headless-shell:156.0.8078.48
//
// Starts the image (CDP on port 9222), opens a small page served from this machine and starts three
// workers: from a script URL, from a blob: URL (what the demo site's /js-heavy probe does) and from a
// data: URL. Each worker is sent 21 and must answer 42 within 3 s. Prints one JSON line and exits 0
// when all three answered, 1 otherwise. Needs Docker; run it again on every new Lightpanda tag
// before removing `lacks: ["webWorker"]` from apps/fleet-runner/src/engines.ts.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/fleet-runner/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const image = process.argv[2];
if (!image) {
  process.stderr.write("usage: node tools/worker-probe.mjs <image>\n");
  process.exit(2);
}

const PAGE_PORT = 3199;
const CDP_PORT = 19229;
const name = `fleetscope-worker-probe-${process.pid}`;

const page = `<!doctype html><html><body><pre id="out">running</pre><script>
const out = { typeofWorker: typeof Worker };
function test(name, make) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { out[name] = "timeout"; resolve(); }, 3000);
    let worker;
    try { worker = make(); } catch (e) { clearTimeout(timer); out[name] = "throws: " + e; return resolve(); }
    worker.onmessage = (e) => { clearTimeout(timer); out[name] = e.data === 42 ? "ok" : "wrong: " + e.data; resolve(); };
    worker.onerror = (e) => { clearTimeout(timer); out[name] = "error: " + (e.message || e.type); resolve(); };
    worker.postMessage(21);
  });
}
const code = "self.onmessage = (e) => self.postMessage(e.data * 2);";
(async () => {
  await test("scriptUrl", () => new Worker("/worker.js"));
  await test("blobUrl", () => new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))));
  await test("dataUrl", () => new Worker("data:text/javascript," + encodeURIComponent(code)));
  document.getElementById("out").textContent = JSON.stringify(out);
})();
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/worker.js") {
    res.setHeader("content-type", "text/javascript");
    res.end("self.onmessage = (e) => self.postMessage(e.data * 2);");
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(page);
}).listen(PAGE_PORT, "0.0.0.0");

let exitCode = 1;
try {
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "LIGHTPANDA_DISABLE_TELEMETRY=true",
      "-p",
      `127.0.0.1:${CDP_PORT}:9222`,
      image,
    ],
    { stdio: "ignore" },
  );

  // Wait for CDP, then use its WebSocket URL with the published port (the advertised host may only
  // be valid inside the container).
  let version;
  for (let i = 0; i < 60 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
    if (!version) await new Promise((r) => setTimeout(r, 500));
  }
  if (!version) throw new Error(`${image} never answered /json/version`);
  const ws = new URL(version.webSocketDebuggerUrl);
  ws.host = `127.0.0.1:${CDP_PORT}`;

  const browser = await chromium.connectOverCDP(ws.toString());
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const tab = await context.newPage();
  await tab.goto(`http://host.docker.internal:${PAGE_PORT}/`);
  await tab
    .waitForFunction(() => document.getElementById("out")?.textContent !== "running", null, {
      timeout: 15_000,
    })
    .catch(() => undefined);
  const result = JSON.parse((await tab.textContent("#out")) || "{}");
  await browser.close().catch(() => undefined);

  const all = ["scriptUrl", "blobUrl", "dataUrl"].every((k) => result[k] === "ok");
  process.stdout.write(
    `${JSON.stringify({ image, version: version["Lightpanda-Version"] ?? version.Browser, workers: all ? "supported" : "not supported", ...result })}\n`,
  );
  exitCode = all ? 0 : 1;
} catch (error) {
  process.stderr.write(`worker-probe: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {}
  server.close();
}
process.exit(exitCode);
