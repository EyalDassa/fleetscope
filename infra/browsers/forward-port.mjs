// Forwards TCP connections from the container's own loopback to a service on the Docker host.
//
// Why: the browsers must open the demo site as http://localhost:3100, the same URL as on the host.
// "localhost" is a secure context in every engine, so crypto.subtle, Workers and the other
// secure-context APIs exist. Under http://host.docker.internal:3100 they do not, and every
// Chromium-based engine would fail the /js-heavy probe for a reason that has nothing to do
// with engine compatibility. Flags that fake a secure origin are Chromium-only, a loopback
// forwarder works for every engine.
//
// Usage: node forward-port.mjs [<upstream-host>:<port>]
// The upstream is the argument, else $DEMO_SITE_UPSTREAM, else host.docker.internal:3100.
// It listens on 127.0.0.1:<port> and [::1]:<port> in its network namespace, with the same port as the
// upstream. It runs in the sidecar image (infra/browsers/forwarder), which shares the browser
// container's network namespace. If it cannot listen on 127.0.0.1, or the upstream is not
// <host>:<port>, it exits non-zero: the runner treats a dead sidecar as a failed session.
import net from "node:net";

const upstream = process.argv[2] ?? process.env.DEMO_SITE_UPSTREAM ?? "host.docker.internal:3100";
const split = upstream.lastIndexOf(":");
const upstreamHost = upstream.slice(0, split);
const port = Number(upstream.slice(split + 1));
if (split < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`forward-port: expected <host>:<port>, got "${upstream}"\n`);
  process.exit(2);
}

function log(message) {
  process.stderr.write(`forward-port: ${message}\n`);
}

function forward(client) {
  const target = net.connect({ host: upstreamHost, port });
  client.pipe(target);
  target.pipe(client);
  const closeBoth = () => {
    client.destroy();
    target.destroy();
  };
  client.on("error", closeBoth);
  client.on("close", closeBoth);
  target.on("close", closeBoth);
  target.on("error", (error) => {
    log(`cannot reach ${upstream}: ${error.message}`);
    closeBoth();
  });
}

// "localhost" can resolve to ::1 as well as 127.0.0.1, so listen on both. Containers often have
// IPv6 switched off, so a failure on ::1 is fine; on 127.0.0.1 it is fatal.
function listen(host, required) {
  const address = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  const server = net.createServer(forward);
  server.on("error", (error) => {
    if (required) {
      log(`cannot listen on ${address}: ${error.message}`);
      process.exit(1);
    }
    log(`not listening on ${address} (${error.code}), continuing without it`);
  });
  server.listen({ host, port }, () => log(`${address} -> ${upstream}`));
}

listen("127.0.0.1", true);
listen("::1", false);

// PID 1 in a container ignores SIGTERM unless it handles it; without this `docker stop` waits 10 s.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
