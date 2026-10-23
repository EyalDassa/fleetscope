# Chromium for the Fleetscope fleet: a Playwright server in its own container.
# The fleet runner starts ONE container per session (see PLAN.md section 3), connects to it with
# `chromium.connect("ws://127.0.0.1:<published port>/")`, and removes it when the session ends.
#
# BUILD CONTEXT is infra/browsers (not this folder) because the port forwarder is shared:
#   pnpm browsers:build
#   = docker build -f infra/browsers/chromium/Dockerfile -t fleetscope/playwright-chromium:1.64.1 infra/browsers
# Run by hand:
#   docker run --rm --init --ipc=host -p 127.0.0.1:3999:3000 \
#     --add-host host.docker.internal:host-gateway fleetscope/playwright-chromium:1.64.1
# More in infra/browsers/README.md.
#
# VERSION PIN: the Playwright client (apps/fleet-runner, packages/collector) and this server must
# be the same version, or `chromium.connect` fails with a protocol mismatch. The value below is the
# single source of truth in this file; .github/scripts/check-playwright-version.sh fails CI when
# the client packages, the image tag in package.json/.env.example/ci.yml, or this file disagree.
# Change it in all of those places together. Check the tag exists first:
#   docker manifest inspect mcr.microsoft.com/playwright:v<version>-noble
ARG PLAYWRIGHT_VERSION=1.64.1

# Ubuntu 24.04 (noble) with the browsers, their system libraries and the `pwuser` account.
# The image has no `playwright` npm package, so we add it below (no download on container start).
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# An ARG declared before FROM is not visible after it, so declare it again.
ARG PLAYWRIGHT_VERSION
LABEL org.opencontainers.image.title="fleetscope-playwright-chromium" \
      org.opencontainers.image.description="Playwright ${PLAYWRIGHT_VERSION} run-server with Chromium, one container per Fleetscope session" \
      fleetscope.playwright-version="${PLAYWRIGHT_VERSION}"

# Install only the CLI/server package, with the exact version. It does not download browsers
# (those come from the base image via PLAYWRIGHT_BROWSERS_PATH=/ms-playwright), and
# --ignore-scripts makes sure no install script runs either.
WORKDIR /opt/playwright-server
RUN npm install --no-save --no-audit --no-fund --ignore-scripts "playwright@${PLAYWRIGHT_VERSION}" \
 && npm cache clean --force
ENV PATH="/opt/playwright-server/node_modules/.bin:${PATH}"

# Loopback forwarder: makes http://localhost:3100 inside the container reach the demo site on the
# host, so pages run in a secure context in every engine. See forward-port.mjs for the reasoning.
# Where it forwards to; the listening port inside the container is the same as the upstream port.
ENV DEMO_SITE_UPSTREAM=host.docker.internal:3100
COPY --chmod=0644 forward-port.mjs /opt/fleetscope/forward-port.mjs
COPY --chmod=0755 chromium/entrypoint.sh /opt/fleetscope/entrypoint.sh

USER pwuser
WORKDIR /home/pwuser
EXPOSE 3000

# Cheap on purpose: bash's built-in /dev/tcp, no extra process such as node. The 30 s interval keeps
# it from adding noise to the per-container CPU samples we collect. The runner does its own, faster
# readiness check (so startup_ms is not rounded up to the health interval); this is for `docker ps`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3000"]

# Start with `docker run --init` (HostConfig.Init) so Chromium's child processes are reaped.
# The entrypoint runs the forwarder and `playwright run-server --port 3000 --host 0.0.0.0` and exits
# when either of them dies.
ENTRYPOINT ["/opt/fleetscope/entrypoint.sh"]
