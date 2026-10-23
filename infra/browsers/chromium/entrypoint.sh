#!/usr/bin/env bash
# Container entrypoint: start the loopback forwarder and the Playwright server side by side, and
# stop the whole container as soon as either one dies. A container that keeps serving Playwright
# without its forwarder would fail every demo-site page in a confusing way, so we prefer to exit.
#
#   forwarder   127.0.0.1:<port> -> $DEMO_SITE_UPSTREAM  (so http://localhost:3100 works here, see forward-port.mjs)
#   run-server  0.0.0.0:3000, the endpoint the fleet runner connects to with chromium.connect()
set -euo pipefail

upstream="${DEMO_SITE_UPSTREAM:-host.docker.internal:3100}"

node /opt/fleetscope/forward-port.mjs "$upstream" &
forwarder=$!
playwright run-server --port 3000 --host 0.0.0.0 &
server=$!

stop_children() { kill "$forwarder" "$server" 2>/dev/null || true; }
# docker stop sends SIGTERM; without a trap bash would ignore it as PID 1 (no --init).
trap 'stop_children; exit 143' TERM INT

status=0
wait -n "$forwarder" "$server" || status=$?
stop_children
wait 2>/dev/null || true
echo "entrypoint: the forwarder or the playwright server exited (status $status), stopping" >&2
# Never exit 0: a dead child is a failure even if it exited cleanly.
exit $((status == 0 ? 1 : status))
