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
| `apps/fleet-runner`, `packages/collector` | `playwright-core`, an exact pin (no `^`) |

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

Playwright's own launch flags already include `--disable-dev-shm-usage` and `--no-sandbox` (read in
`playwright-core@1.64.1`), so a small `/dev/shm` and running without a seccomp profile are fine.
Playwright's Docker docs recommend `--ipc=host`; it is not needed for that reason, and it would
share one IPC namespace between concurrent sessions.

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
- The forwarder is a Node process (`net` only, no dependencies). It adds a little baseline memory
  to the container; Docker's per-container numbers include it. Every engine image uses the same
  forwarder, so the comparison stays fair.
- The demo site must listen on an address the Docker host gateway can reach: `0.0.0.0` (its default,
  `DEMO_SITE_HOST`). On Linux and in CI `host.docker.internal` is the Docker bridge address, which a
  loopback-only listener does not accept.

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
