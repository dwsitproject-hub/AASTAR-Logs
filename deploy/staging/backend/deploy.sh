#!/usr/bin/env bash
# Staging backend (172.28.92.57): pull, build, migrate the RDS schema, (re)start, check.
#
#   ./deploy.sh                  pull the checked-out branch and deploy it
#   ./deploy.sh --no-pull        deploy what is on disk (e.g. after `git checkout <commit>` for a rollback)
#   ./deploy.sh --skip-migrate   do not touch the RDS schema (the app does not read RDS before Phase 1)
set -euo pipefail
cd "$(dirname "$0")"

PULL=1
MIGRATE=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --skip-migrate) MIGRATE=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

BIND_IP="${BACKEND_BIND_IP:-172.28.92.57}"
PORT="${BACKEND_HOST_PORT:-4150}"
CONTAINER=astar-erp-backend-staging

[ -f .env.staging ] || { echo "Missing .env.staging - run: cp .env.staging.example .env.staging" >&2; exit 1; }
# Settings only: comment lines may mention the placeholder.
if grep -nE '^[^#]*REPLACE_ME' .env.staging; then echo "Fill in the REPLACE_ME values above in .env.staging first." >&2; exit 1; fi
ls service-accounts/*.json >/dev/null 2>&1 || echo "WARNING: no Google key in service-accounts/ - the sheet sync cannot run."

if [ "$PULL" = 1 ]; then git -C ../../.. pull --ff-only; fi
echo "Deploying $(git -C ../../.. rev-parse --short HEAD) from branch $(git -C ../../.. rev-parse --abbrev-ref HEAD)"

docker compose build
if [ "$MIGRATE" = 1 ]; then
  echo "Applying RDS schema migrations..."
  docker compose run --rm --no-deps backend node scripts/db-migrate.js
fi
docker compose up -d

status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 2
done
echo "Container $CONTAINER: $status"
curl -fsS "http://$BIND_IP:$PORT/api/health" && echo
curl -sS "http://$BIND_IP:$PORT/api/ready" && echo
if [ "$status" != healthy ]; then
  echo "Not healthy - last log lines:" >&2
  docker logs --tail 40 "$CONTAINER" >&2
  exit 1
fi
