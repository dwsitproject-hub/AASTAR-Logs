#!/usr/bin/env bash
# Docker Compose for this app's production containers. The compose files stay in
# the checkout; everything filled in on the server is read from /opt/astar-erp
# (.env, production.env, secrets.production.env, service-accounts/).
#
#   /opt/astar-erp/src/deploy/production/dc.sh be ps          # on 172.28.80.51
#   /opt/astar-erp/src/deploy/production/dc.sh fe logs -f     # on 172.28.80.50
set -euo pipefail
ROLE="${1:-}"
case "$ROLE" in be|fe) shift ;; *) echo "usage: dc.sh be|fe <docker compose command...>" >&2; exit 2 ;; esac
RUN="${ASTAR_RUN_DIR:-/opt/astar-erp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
exec docker compose --project-directory "$RUN" -f "$HERE/$ROLE.compose.yml" "$@"
