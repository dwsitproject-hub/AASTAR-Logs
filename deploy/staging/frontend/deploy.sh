#!/usr/bin/env bash
# Staging frontend (172.28.92.56): pull, build with the git commit as the release
# reported to DWS Hub (Sentinel reads that commit's code), (re)start, check.
#
#   ./deploy.sh            pull the checked-out branch and deploy it
#   ./deploy.sh --no-pull  deploy what is on disk (e.g. after `git checkout <commit>` for a rollback)
set -euo pipefail
cd "$(dirname "$0")"

PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0
CONTAINER=astar-erp-frontend-staging

[ -f .env ] || { echo "Missing .env - run: cp .env.example .env" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${VITE_HUB_SDK_KEY:-}" ] || echo "WARNING: VITE_HUB_SDK_KEY is empty - building without the DWS Hub SDK."

if [ "$PULL" = 1 ]; then git -C ../../.. pull --ff-only; fi
export VITE_GIT_SHA
VITE_GIT_SHA=$(git -C ../../.. rev-parse --short HEAD)
echo "Deploying release $VITE_GIT_SHA from branch $(git -C ../../.. rev-parse --abbrev-ref HEAD)"

docker compose build
docker compose up -d

status=starting
for _ in $(seq 1 20); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 2
done
echo "Container $CONTAINER: $status"
curl -fsS "http://127.0.0.1:$FRONTEND_HOST_PORT/healthz"
curl -sS "http://127.0.0.1:$FRONTEND_HOST_PORT/api/health" && echo
curl -s "http://127.0.0.1:$FRONTEND_HOST_PORT/" | grep -o 'data-release="[^"]*"' || echo "(no Hub SDK tag in the page)"
if [ "$status" != healthy ]; then
  docker logs --tail 40 "$CONTAINER" >&2
  exit 1
fi
