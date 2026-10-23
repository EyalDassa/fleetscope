# Browser images

The fleet runner starts **one container per session** (PLAN.md section 3) and removes it when the
session ends. This folder holds the images. M1 has one, for Chromium. The chrome-headless-shell and
Lightpanda images arrive in M3.

```
infra/browsers/
  chromium/Dockerfile      Playwright server + Chromium
  chromium/entrypoint.sh   starts the forwarder and the server, exits when either dies
  forward-port.mjs         loopback forwarder (shared by every browser image)
```

## Chromium: `fleetscope/playwright-chromium:1.64.1`

Based on `mcr.microsoft.com/playwright:v1.64.1-noble` (Ubuntu 24.04, browsers in `/ms-playwright`).
It adds the `playwright@1.64.1` npm package, so containers do not download anything on start, and
runs `playwright run-server --port 3000 --host 0.0.0.0` as the non-root user `pwuser`.

```bash
pnpm browsers:build        # docker build -f infra/browsers/chromium/Dockerfile ... infra/browsers
```

The first build pulls the Playwright base image: 0.98 GB to download (7 layers, summed from the
registry manifest), several GB once unpacked. Keep **at least 10 GB free** on the drive that holds
Docker's disk image. When that drive fills up, Docker Desktop's engine goes read-only and stops
answering until Docker Desktop is restarted (this happened while this image was first built).

### The version rule

`chromium.connect()` only works when the Playwright client and the server are the **same version**.
The version is written down in these places, and `.github/scripts/check-playwright-version.sh --strict`
(CI job "Lint, typecheck, unit tests") fails if they differ:

| Where | What |
|---|---|
| `infra/browsers/chromium/Dockerfile` | `ARG PLAYWRIGHT_VERSION=1.64.1` (the source of truth) |
| `package.json` | the tag in `browsers:build` |
| `.env.example` | `FLEET_BROWSER_IMAGE` |
| `.github/workflows/ci.yml` | the image tag and `FLEET_BROWSER_IMAGE` of the fleet smoke job |
| `apps/fleet-runner/src/config.ts` | `DEFAULT_BROWSER_IMAGE`: what the runner uses when `FLEET_BROWSER_IMAGE` is not set |
| `apps/fleet-runner`, `packages/collector` | `playwright-core`, an exact pin (no `^`) |

A developer's own `.env` is not checked: after an upgrade, update `FLEET_BROWSER_IMAGE` there too
(or delete the line to use the default).

To upgrade: check that `v<new>-noble` exists on MCR (`docker manifest inspect
mcr.microsoft.com/playwright:v<new>-noble`) and on npm, then change all of the above in one commit.

### Run it by hand

```bash
docker run --rm --init -p 127.0.0.1:3999:3000 \
  --add-host host.docker.internal:host-gateway \
  fleetscope/playwright-chromium:1.64.1
# then, from a Node script with playwright-core@1.64.1:
#   const browser = await chromium.connect("ws://127.0.0.1:3999/");
```

What the runner should set when it creates the container (dockerode `HostConfig`):

| Setting | Why |
|---|---|
| `Init: true` (`--init`) | reaps Chromium's child processes |
| `PortBindings: 3000/tcp -> 127.0.0.1:<random>` | **loopback only**: `run-server` has no authentication, anyone who can reach the port can drive a browser |
| `ExtraHosts: ["host.docker.internal:host-gateway"]` | lets the forwarder reach the demo site on the host (needed on Linux and CI, harmless on Docker Desktop) |
| `Env: DEMO_SITE_UPSTREAM=host.docker.internal:<demo site port>` | optional, the default is `host.docker.internal:3100` |
| no `IpcMode` (Docker's default, `private`) | every session gets its own IPC namespace and its own 64 MB `/dev/shm`, which disappear with the container. **Never `host`**: it would share the host's IPC namespace and `/dev/shm` between sessions and let shared memory outlive them, which breaks "no state leaking between sessions" |

**Why a small `/dev/shm` is enough.** Playwright's own launch flags already include
`--disable-dev-shm-usage` and `--no-sandbox` (read in `playwright-core@1.64.1`), so Chromium keeps
its shared memory out of `/dev/shm`. Playwright's Docker docs recommend `--ipc=host` for the general
case; we do not follow that. Checked on 2026-10-23 with the default private IPC and
`ShmSize=67108864` (64 MB): 6 containers (3 runs of the measurement below) each loaded
`/heavy?images=200` three times with no crash. If crashes ever show up under load, give each
container a bigger `ShmSize` (for example 256 MB) instead of sharing the host's IPC namespace.

`run-server` options in 1.64.1: `--port`, `--host`, `--path` (default `/`), `--max-clients`,
`--artifacts-dir`, `--unsafe`. Without `--unsafe` the client cannot set launch options such as
`args` or `executablePath`. We do not need them; do not add `--unsafe` to open that up.

### Why `http://localhost:3100` works inside the container

The scenarios open the demo site as `http://localhost:3100`, the same URL as on the host.
The entrypoint starts `forward-port.mjs`, which listens on `127.0.0.1:3100` (and `[::1]:3100`)
inside the container and forwards every connection to `host.docker.internal:3100`.

**Why not browse to `http://host.docker.internal:3100` directly?** That origin is *not* a secure
context. `crypto.subtle`, Service Workers and other secure-context APIs do not exist there, so every
Chromium-based engine would fail the demo site's `/js-heavy` WebCrypto probe, and that failure
would hide the real compatibility gaps we want to show for Lightpanda. `localhost` is a secure
context in every engine. The Chromium-only flags that fake a secure origin
(`--unsafely-treat-insecure-origin-as-secure`, `--host-resolver-rules`) are no option for Lightpanda.

Details worth knowing:

- The listening port equals the upstream port, so `DEMO_SITE_UPSTREAM=host.docker.internal:3200`
  gives `http://localhost:3200` inside the container.
- The entrypoint exits (non-zero) as soon as the forwarder **or** the Playwright server dies. A
  container that kept serving without its forwarder would fail every demo-site page in a confusing way.
- The forwarder is a Node process (`net` only, no dependencies) **inside the browser container's
  cgroup**. Its memory and CPU are therefore part of every container sample we store: about
  10 to 17 MB of memory in a Chromium container (measured, next section). That is a small share of
  Chromium's 130 to 400 MB, but it is not "fair" to add the same constant to every engine: it shrinks
  the ratio between a small engine and Chromium. The M3 plan below takes it out of the session.
- The demo site must listen on an address the Docker host gateway can reach: `0.0.0.0` (its default,
  `DEMO_SITE_HOST`). On Linux and in CI `host.docker.internal` is the Docker bridge address, which a
  loopback-only listener does not accept.

### What the forwarder costs (measured)

Measured on 2026-10-23: Docker 29.9.2 on Docker Desktop (WSL2, cgroup v2), image
`fleetscope/playwright-chromium:1.64.1` (Chromium headless shell 156.0.8078.4), 3 runs. In each run
two fresh containers of the same image: **with** the forwarder (the normal entrypoint, page at
`http://localhost:3100`) and **without** it (`--entrypoint playwright run-server`, page at
`http://host.docker.internal:3100`). The page is `/heavy?images=200` (5000 nodes, 200 small images).
Memory is container cgroup usage minus `inactive_file`, the formula the runner uses for `mem_mb`
(`apps/fleet-runner/src/stats.ts`); "MB" below means 1024 x 1024 bytes, as there. The measuring
script is a throwaway and is not in the repo; the numbers are:

| Stage | With forwarder (MB) | Without (MB) | Difference per run (MB) |
|---|---|---|---|
| idle: server up, no client | 129.1 (128.5 to 129.6) | 118.9 (118.0 to 119.6) | +9.5, +9.6, +11.6 |
| one `/heavy` page loaded | 276.7 (274.9 to 277.1) | 263.6 (263.1 to 264.3) | +13.1, +10.6, +14.0 |
| the page loaded 3 times | 401.8 (391.3 to 402.1) | 386.0 (385.1 to 387.2) | +15.8, +4.1, +17.0 |

(median, then min to max.) Reading it:

- **About 10 MB at idle and 11 to 17 MB with a page loaded.** The +4.1 in the last row is a run where
  Chromium itself used less; Chromium varies by more than that between runs. The forwarder is about
  8 % of an idle container and about 4 to 5 % of one with the page loaded (1 % in that one run).
- **The forwarder process by itself** (`/proc/<pid>/status` in the "with" containers): RSS 46.7 to
  46.9 MB at idle, but only 9.4 MB of that is private (`RssAnon`); the other ~37 MB is the `node`
  binary and libraries, which the Playwright server's own `node` process shares. After the page
  loads RSS is 53.4 to 53.8 MB (private about 13.5 MB, read in the last run), and the peak equals the
  final value: no spike. So the cgroup sees the private part, which is why the difference above is ~10 MB, not ~47 MB.
- **CPU.** The forwarder used 30 ms at idle (startup) and 430 to 450 ms after the three loads, for
  about 1.18 million bytes of loopback traffic. The whole container used 12.5 to 13.9 s over the same span with the
  forwarder and 11.9 to 13.8 s without, so the forwarder is about 3 % of it. The container total was
  0.1 to 0.7 s higher with the forwarder, which fits its own 0.4 s, but Chromium alone varies by as
  much between runs, so the per-sample `cpu_pct` cannot be corrected for it. CPU grows with the bytes
  proxied, so a page with large images costs more (not measured).
- **IPC.** `docker inspect` showed `IpcMode private`, `ShmSize 67108864` for all six containers.

**This is included in every container sample.** Every `mem_mb` and `cpu_pct` we store for a Chromium
session contains the forwarder: roughly 10 to 17 MB and a few percent of the container's CPU. We have
not subtracted it, because it cannot be separated per sample.

### M3 plan: the forwarder moves into a sidecar container

Decision (lead, 2026-10-23, from review R-M1-06): implement this in M3, together with the
Lightpanda image, not in M1. Chromium's 130 to 400 MB dwarfs the forwarder, but for Lightpanda,
whose whole footprint is expected to be small, the same 10 to 17 MB would be a large share of every
sample. The Lightpanda image would also have to ship Node only for the forwarder.

The plan: per session the runner starts a **second container** that joins the browser container's
network namespace (dockerode `HostConfig.NetworkMode: "container:<browser container id>"`) and runs
only `node /opt/fleetscope/forward-port.mjs host.docker.internal:3100`. Inside the browser
container `localhost:3100` still works, and the forwarder's memory and CPU land in the sidecar's
own cgroup, not the session's. The browser image no longer needs Node or the forwarder, and the
runner's stats keep reading the browser container only.

**Checked by hand on 2026-10-23, not implemented.** A = Chromium container with `run-server` only
(no forwarder), S = sidecar started with `--network container:A`, no `--add-host` on S:

- A and S have the same network namespace (`/proc/self/ns/net` is `net:[4026532455]` in both).
- S uses A's `/etc/hosts`: a marker entry given only to A (`--add-host marker-from-a.test:10.9.8.7`)
  was in S's file and resolved in S. So `ExtraHosts: host.docker.internal:host-gateway` goes on the
  **browser** container only, and works on Linux CI too (it does not rely on Docker Desktop's DNS).
  Docker refuses the option on the sidecar itself: `--add-host` together with `--network container:`
  fails with `conflicting options: custom host-to-IP mapping and the network mode`.
- S listens on `127.0.0.1:3100` and `[::1]:3100` inside the shared namespace.
- A page in A opened `http://localhost:3100/js-heavy`: status 200, `origin http://localhost:3100`,
  `isSecureContext true`, `typeof crypto.subtle` is `object`.
- A's cgroup: 122.5 MB with only `playwright run-server` in it (no forwarder process). S's cgroup:
  16.7 MB in total (private memory 13.7 MB; the `node` process has RSS 47.5 MB, of which 37.9 MB is
  file pages that the cgroup does not charge to S).

Things M3 has to do that the spike did not cover:

- Start the sidecar after the browser container exists, before the first `goto`, and remove both
  at the end (give both the `fleetscope.session` label so `pnpm fleet cleanup` sweeps both).
- The entrypoint's "exit when the forwarder dies" guard moves to the runner: a dead sidecar must
  fail the session (today the container exits, and the runner sees a crashed session).
- Two containers per session: expect a longer `startup_ms` and count both against any concurrency limit.
- Decide whether to record the sidecar's own stats (it would show the overhead) or ignore them.

The alternative that was considered: a native forwarder of about 1 MB (`socat`) installed in every
image. Simpler to run, but each image carries it inside the session's cgroup, so it is cheaper
than Node yet still not zero, and it must be documented per engine. Not chosen.

### Known limitation: sessions can reach each other's `run-server`

The runner publishes each container's port 3000 on `127.0.0.1` only, so nothing outside the machine
can reach it. But the containers sit on Docker's **default bridge network**, which lets containers
talk to each other, and `run-server` listens on `0.0.0.0` with no authentication. Verified on
2026-10-23: a container started separately connected with `chromium.connect("ws://172.17.0.2:3000/")`
to another session's browser and loaded a page in it.

This is accepted for local development in M1 and M2: the sessions only visit our own demo site, and
Playwright's `--no-sandbox` makes the container the only boundary, so it must be fixed **before the
fleet browses third-party sites** (R-M1-09). The runner does not need containers to reach each
other, because it connects through the published port. Options, not tried: a dedicated network
created with `com.docker.network.bridge.enable_icc=false`, or one network per session.

### File permissions in the image (a bug we hit)

The first CI run failed with `[FATAL tini] exec /opt/fleetscope/entrypoint.sh failed: Permission
denied`, exit code 126, for every container. Cause: `COPY --chmod=0644 forward-port.mjs
/opt/fleetscope/...` made BuildKit create `/opt/fleetscope` itself with mode `0644` (it applies
`--chmod` to directories it creates, moby/buildkit#5943), and `pwuser` cannot enter such a
directory, although the entrypoint file inside was `0755`.

So the Dockerfile now creates the directory and sets every mode with `chmod`, with no `COPY --chmod`,
and a last `RUN` as `pwuser` (`test -x`, `test -r`, `bash -n`, `node --check`) makes the **build**
fail if the user cannot use the files. A second cause gives the same message: a script committed
from Windows is stored as `100644`. The chmod covers that for the image, and CI (`check-executable-bits.sh`)
fails if a `.sh` file under `.github/` or `infra/` is not `100755` in git. To fix one:
`git update-index --chmod=+x <file>` (tracked file) or `git add --chmod=+x <file>` (new file).

### Health check

`HEALTHCHECK` opens a TCP connection to port 3000 with bash's built-in `/dev/tcp` every 30 s.
It is for `docker ps`; it is deliberately slow and cheap so it does not disturb the per-container CPU
samples. The runner does its own, faster readiness check, so `startup_ms` is not rounded up to the
health interval.
