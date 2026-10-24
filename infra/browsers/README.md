# Browser images

The fleet runner starts **one browser container per session** (PLAN.md section 3) plus a small
**forwarder sidecar** next to it, and removes both when the session ends.

```
infra/browsers/
  chromium/Dockerfile    Playwright server + Chromium               -> fleetscope/playwright-chromium:1.64.1-2
  forwarder/Dockerfile   the sidecar (Node + forward-port.mjs)      -> fleetscope/forwarder:1-1
  forward-port.mjs       loopback port forwarder (runs in the sidecar only)
```

| Engine | Image | Built or pulled | Port | Ready when |
|---|---|---|---|---|
| `chromium` | `fleetscope/playwright-chromium:1.64.1-2` | built, `pnpm browsers:build` | 3000 (Playwright `run-server`) | TCP connect |
| `chrome-headless-shell` | `chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423` | pulled, `pnpm browsers:pull`, unmodified | 9222 (CDP) | `GET /json/version` |
| `lightpanda` | `lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9` | pulled, `pnpm browsers:pull`, unmodified | 9222 (CDP) | `GET /json/version` |
| sidecar | `fleetscope/forwarder:1-1` | built, `pnpm browsers:build` | none (loopback only) | log line `127.0.0.1:3100 -> ...` |

The runner reads the image names from `FLEET_BROWSER_IMAGE_CHROMIUM`,
`FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL`, `FLEET_BROWSER_IMAGE_LIGHTPANDA` and
`FLEET_FORWARDER_IMAGE` (`.env.example`). `FLEET_BROWSER_IMAGE` is the older name for the Chromium image
and is only a fallback.

```bash
pnpm browsers:build   # chromium + forwarder images (several GB the first time, see below)
pnpm browsers:pull    # the two upstream images (headless-shell 537 MB on disk, Lightpanda 224 MB)
```

Checked on 2026-10-24 (Docker Hub, `docker pull` and `docker inspect`):

- `chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423`: entrypoint `/headless-shell/run.sh`, exposes 9222 and 9223
  (Chrome listens on 9223 and a `socat` in the image republishes it on 9222).
- `lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9`: entrypoint `tini --`, command `lightpanda serve --host 0.0.0.0 --port 9222`,
  runs as the user `lightpanda`. `GET /json/version` answers `{"Browser": "Lightpanda/1.0", ...,
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/"}`.
  **That URL carries the container's own port 9222, not the published one.** `chromium.connectOverCDP("http://127.0.0.1:<published>")`
  reads it and fails with `ECONNREFUSED 127.0.0.1:9222` (we hit this). Use `connectOverCDP("ws://127.0.0.1:<published>/")`
  for Lightpanda, and use `/json/version` for readiness only.
- `node:22-alpine` (base of the forwarder) exists on Docker Hub.

The first build of the Chromium image pulls the Playwright base image: 0.98 GB to download (7 layers,
summed from the registry manifest), several GB once unpacked. Keep **at least 10 GB free** on the drive
that holds Docker's disk image. When that drive fills up, Docker Desktop's engine goes read-only and
stops answering until Docker Desktop is restarted (this happened while this image was first built).

## The version rules

**Chromium.** `chromium.connect()` only works when the Playwright client and the server are the **same
version**. `.github/scripts/check-playwright-version.sh --strict` (CI job "Lint, typecheck, unit tests")
fails if these differ. The image tag is `<playwright version>-<image revision>`, for example `1.64.1-2`;
the revision is *our* number, bumped when the Dockerfile changes behaviour (revision 2 took the
forwarder out of the image).

| Where | What |
|---|---|
| `infra/browsers/chromium/Dockerfile` | `ARG PLAYWRIGHT_VERSION=1.64.1` and `ARG IMAGE_REVISION=2` (the source of truth) |
| `package.json` | the tag in `browsers:build` |
| `.env.example` | `FLEET_BROWSER_IMAGE_CHROMIUM` |
| `.github/workflows/ci.yml` | the image tag and `FLEET_BROWSER_IMAGE_CHROMIUM` of the fleet smoke job |
| `infra/browsers/README.md` | this file (the table above and the run-by-hand example) |
| `apps/fleet-runner/src/engines.ts` | the default image, used when the env var is not set |
| `apps/fleet-runner`, `packages/collector` | `playwright-core`, an exact pin (no `^`) |

**Upstream and sidecar images.** Tags on Docker Hub are mutable, so the two upstream images are pinned
by tag **and digest** (`<tag>@sha256:<digest of the image index>`; the tag is for humans, Docker uses the
digest). Get a digest with `docker buildx imagetools inspect <image>:<tag>`, checked on 2026-10-24 for
`156.0.8078.48` and `1.0.2`. Our sidecar is tagged `1-<revision>` (`ARG IMAGE_REVISION` in
`forwarder/Dockerfile`), bumped whenever the Dockerfile or `forward-port.mjs` changes, so a stale local
image is never reused under the old tag. `.github/scripts/check-browser-images.sh --strict` checks that
the three images are written the same way, digest and revision included, in `.env.example` (the reference), `.github/workflows/ci.yml`, the runner's `engines.ts`,
this README, and (for the forwarder) the `browsers:build` script in `package.json`. Both scripts print
what they compared.

A developer's own `.env` is not checked: after an upgrade, update the `FLEET_BROWSER_IMAGE_*` lines there
too (or delete them to use the defaults). **A stale `.env` that still names `playwright-chromium:1.64.1`
runs the old image, which still starts its own forwarder; the sidecar then fails to bind port 3100.**
That is why the tag changed to `1.64.1-2`: an old image is simply not found.

To upgrade Chromium: check that `v<new>-noble` exists on MCR (`docker manifest inspect
mcr.microsoft.com/playwright:v<new>-noble`) and on npm, then change all of the above in one commit. To
upgrade an upstream image: `docker manifest inspect <image>:<tag>`, then change every place in the
second list. Dependabot (`.github/dependabot.yml`) watches the base images in the Dockerfiles here.

## Chromium: run it by hand

```bash
docker run --rm --init -p 127.0.0.1:3999:3000 \
  --add-host host.docker.internal:host-gateway \
  fleetscope/playwright-chromium:1.64.1-2
# then, from a Node script with playwright-core@1.64.1:
#   const browser = await chromium.connect("ws://127.0.0.1:3999/");
```

The image has Node and the `playwright` package and runs `playwright run-server --port 3000 --host
0.0.0.0` as the non-root user `pwuser`; nothing else. There is no entrypoint script (so no file mode
that a Windows commit can break).

What the runner sets when it creates the container (dockerode `HostConfig`):

| Setting | Why |
|---|---|
| `Init: true` (`--init`) | reaps Chromium's child processes |
| `PortBindings: 3000/tcp -> 127.0.0.1:<random>` | **loopback only**: `run-server` has no authentication, anyone who can reach the port can drive a browser |
| `ExtraHosts: ["host.docker.internal:host-gateway"]` | the sidecar resolves the host through the **browser** container's `/etc/hosts` (needed on Linux and CI, harmless on Docker Desktop) |
| no `IpcMode` (Docker's default, `private`) | every session gets its own IPC namespace and its own 64 MB `/dev/shm`, which disappear with the container. **Never `host`**: it would share the host's IPC namespace and `/dev/shm` between sessions and let shared memory outlive them, which breaks "no state leaking between sessions" |

**Why a small `/dev/shm` is enough.** Playwright's own launch flags already include
`--disable-dev-shm-usage` and `--no-sandbox` (read in `playwright-core@1.64.1`), so Chromium keeps
its shared memory out of `/dev/shm`. Playwright's Docker docs recommend `--ipc=host` for the general
case; we do not follow that. Checked on 2026-10-23 with the default private IPC and
`ShmSize=67108864` (64 MB): 6 containers each loaded `/heavy?images=200` three times with no crash.
If crashes ever show up under load, give each container a bigger `ShmSize` (for example 256 MB)
instead of sharing the host's IPC namespace.

`run-server` options in 1.64.1: `--port`, `--host`, `--path` (default `/`), `--max-clients`,
`--artifacts-dir`, `--unsafe`. Without `--unsafe` the client cannot set launch options such as
`args` or `executablePath`. We do not need them; do not add `--unsafe` to open that up.

## The forwarder sidecar: why `http://localhost:3100` works in every engine

The scenarios open the demo site as `http://localhost:3100`, the same URL as on the host.

**Why not `http://host.docker.internal:3100`?** That origin is *not* a secure context.
`crypto.subtle`, Service Workers and other secure-context APIs do not exist there, so every
Chromium-based engine would fail the demo site's `/js-heavy` WebCrypto probe, and that failure would hide
the real compatibility gaps we want to show for Lightpanda. `localhost` is a secure context in every
engine. The Chromium-only flags that fake a secure origin (`--unsafely-treat-insecure-origin-as-secure`,
`--host-resolver-rules`) are no option for Lightpanda.

**How.** Per session the runner starts a second container from `fleetscope/forwarder:1-1` with
`HostConfig.NetworkMode: "container:<browser container id>"`. It shares the browser container's network
namespace (so the same `localhost`) but has its own cgroup. It runs `node forward-port.mjs`, which
listens on `127.0.0.1:3100` and `[::1]:3100` and forwards each connection to
`$DEMO_SITE_UPSTREAM` (default `host.docker.internal:3100`).

```bash
# by hand (browser = any of the three engines):
B=$(docker run -d --init --add-host host.docker.internal:host-gateway lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9)
S=$(docker run -d --network container:$B fleetscope/forwarder:1-1)   # no --add-host here, see below
docker logs $S    # forward-port: 127.0.0.1:3100 -> host.docker.internal:3100
docker run --rm --network container:$B node:22-alpine wget -qO- http://localhost:3100/healthz
```

Details worth knowing:

- The listening port equals the upstream port, so `DEMO_SITE_UPSTREAM=host.docker.internal:3200`
  gives `http://localhost:3200` in the browser. The runner passes the variable to the **sidecar**.
- `ExtraHosts` goes on the **browser** container: Docker refuses `--add-host` together with
  `--network container:` (`conflicting options: custom host-to-IP mapping and the network mode`), and the
  sidecar uses the browser's `/etc/hosts`. Verified with a marker entry given only to the browser.
- The sidecar exits non-zero if it cannot listen on `127.0.0.1` (for example an old Chromium image is
  already listening there) or if `DEMO_SITE_UPSTREAM` is not `<host>:<port>`. A dead sidecar must fail the
  session: the runner has to watch it (the old entrypoint's "exit when the forwarder dies" guard is gone).
  `[::1]` is optional, containers often have IPv6 switched off.
- The sidecar handles SIGTERM, so `docker stop` is immediate.
- The runner needs both containers labelled `fleetscope.session` so `pnpm fleet cleanup` and the CI leak
  check sweep both, and must start the sidecar before the first `goto` and remove it with the browser.
- The demo site must listen on an address the Docker host gateway can reach: `0.0.0.0` (its default,
  `DEMO_SITE_HOST`). On Linux and in CI `host.docker.internal` is the Docker bridge address, which a
  loopback-only listener does not accept.

### Why a sidecar (measured)

The forwarder used to run inside the Chromium container, so every `mem_mb` and `cpu_pct` we stored
contained it, a constant that makes a small engine look relatively bigger and Chromium relatively
smaller. Moving it out puts it in its own cgroup. Measured on 2026-10-24 on Docker Desktop (WSL2,
cgroup v2, Docker 29.9.2), same machine, same page (`/heavy?images=200`, 5000 nodes), memory = cgroup
usage minus `inactive_file`, the formula of `apps/fleet-runner/src/stats.ts`, in MB (1024 x 1024).
Old = `playwright-chromium:1.64.1` (forwarder in the image), new = `1.64.1-2` + sidecar. Three alternating
runs (the first old run, 261.9 / 366.2, was a cold outlier and is excluded from the medians):

| Stage | Old, forwarder in the container | New, sidecar | Difference |
|---|---|---|---|
| idle, browser launched, no page | 175.2 / 175.1 | 165.1 / 164.7 / 165.2 | about 10 MB |
| `/heavy` page loaded | 276.3 / 279.3 | 266.7 / 264.2 / 266.6 | about 12 MB |
| the sidecar's own cgroup | (inside the browser) | 17.4 to 17.7 | now visible, not in the session |

So the browser container's samples drop by 10 to 12 MB (4 to 6 %), and the sidecar costs 17.5 MB in a
cgroup nobody samples. Earlier (2026-10-23) measurement of the in-image forwarder with three runs agreed:
+9.5 to +11.6 MB idle, +4 to +17 MB with the page loaded. The forwarder's CPU was about 3 % of the
container's (0.43 s over three page loads).

Checked in the same runs from a page inside each engine (via the sidecar):

| Engine | `http://localhost:3100/js-heavy` | `isSecureContext` | `typeof crypto.subtle` |
|---|---|---|---|
| chromium (`1.64.1-2`) | 200 | true | object |
| chrome-headless-shell | 200 | true | object |
| lightpanda | reachable only (a `wget` in the same namespace got `{"status":"ok"}`) | not tested | not tested |

Things the sidecar changes for the runner: two containers per session (expect a longer `startup_ms`, and
count both against any concurrency limit), and the runner's stats keep reading the browser container only.
Whether to also record the sidecar's own stats is open; the number above is a good constant to document.

A native forwarder of about 1 MB (`socat`) installed in every image was the alternative: simpler to run,
but it would sit in each session's cgroup.
Not chosen.

## Known limitation: sessions can reach each other's browser

The runner publishes each container's port on `127.0.0.1` only, so nothing outside the machine can reach
it. But the containers sit on Docker's **default bridge network**, which lets containers talk to each
other, and `run-server` / CDP listen on `0.0.0.0` with no authentication. Verified on 2026-10-23: a
container started separately connected with `chromium.connect("ws://172.17.0.2:3000/")` to another
session's browser and loaded a page in it.

This is accepted for local development: the sessions only visit our own demo site, and `--no-sandbox`
makes the container the only boundary, so it must be fixed **before the fleet browses third-party
sites** (R-M1-09). The runner does not need containers to reach each other, because it connects through
the published port. Options, not tried: a dedicated network created with
`com.docker.network.bridge.enable_icc=false`, or one network per session.

## File permissions (a bug we hit)

The first CI run failed with `[FATAL tini] exec /opt/fleetscope/entrypoint.sh failed: Permission
denied`, exit code 126, for every container. Cause: `COPY --chmod=0644 forward-port.mjs
/opt/fleetscope/...` made BuildKit create `/opt/fleetscope` itself with mode `0644` (it applies `--chmod`
to directories it creates, moby/buildkit#5943), and `pwuser` cannot enter such a directory.

Today there is no entrypoint script in either image (both use an exec-form `ENTRYPOINT`), and the
forwarder Dockerfile sets modes with `chmod`, not `COPY --chmod`, and a last `RUN` as the runtime user
(`test -r`, `node --check`) makes the **build** fail if that user cannot read the file. A script committed
from Windows is stored as `100644`; CI (`check-executable-bits.sh`) fails if a `.sh` file under `.github/`
or `infra/` is not `100755` in git. To fix one: `git update-index --chmod=+x <file>` (tracked file) or
`git add --chmod=+x <file>` (new file).

## Health check

The Chromium image's `HEALTHCHECK` opens a TCP connection to port 3000 with bash's built-in `/dev/tcp`
every 30 s. It is for `docker ps`; it is deliberately slow and cheap so it does not disturb the
per-container CPU samples. The runner does its own, faster readiness check, so `startup_ms` is not
rounded up to the health interval. The upstream images are used unmodified, with no health check of ours.
