# Sidecar that makes http://localhost:3100 inside a browser container reach the demo site on the host.
# The fleet runner starts ONE of these per session with `NetworkMode: container:<browser container id>`,
# so it shares the browser's network namespace (its `localhost`) but NOT its cgroup: the forwarder's
# memory and CPU are not counted in the browser's samples (that is the point, see README.md).
#
#   pnpm browsers:build
#   = docker build -f infra/browsers/forwarder/Dockerfile -t fleetscope/forwarder:1 infra/browsers
#
# Listens on 127.0.0.1:<port> and [::1]:<port>, forwards to $DEMO_SITE_UPSTREAM
# (default host.docker.internal:3100; the port inside equals the upstream port). Exits non-zero if it
# cannot bind 127.0.0.1 or the upstream value is not <host>:<port>. The host name resolves through
# the BROWSER container's /etc/hosts (ExtraHosts goes on the browser container: Docker refuses
# --add-host together with --network container:).
#
# Alpine keeps the image small (about 60 MB, Node only for this one script). Non-root user `node`.
FROM node:22-alpine

LABEL org.opencontainers.image.title="fleetscope-forwarder" \
      org.opencontainers.image.description="Loopback port forwarder sidecar for Fleetscope browser containers"

ENV DEMO_SITE_UPSTREAM=host.docker.internal:3100

# No COPY --chmod (BuildKit would apply it to the directory it creates, moby/buildkit#5943). The file
# only needs to be readable: it is run as `node <file>`, never executed directly.
COPY forward-port.mjs /opt/fleetscope/forward-port.mjs
RUN chmod 0755 /opt/fleetscope && chmod 0644 /opt/fleetscope/forward-port.mjs

USER node

# Fail the BUILD if the runtime user cannot use the file.
RUN test -r /opt/fleetscope/forward-port.mjs && node --check /opt/fleetscope/forward-port.mjs

# Exec form, no shell: node is PID 1 and forward-port.mjs handles SIGTERM itself.
ENTRYPOINT ["node", "/opt/fleetscope/forward-port.mjs"]
