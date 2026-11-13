#!/usr/bin/env bash
# Production release on ONE server (docs/DEPLOYMENT-PRODUCTION.md §7, §8, §12).
# Production runs a release TAG - a commit that passed staging - never "whatever main is".
#
#   /opt/astar-erp/src/deploy/production/release.sh be v1.0.0                  # BE 172.28.80.51 first
#   /opt/astar-erp/src/deploy/production/release.sh fe v1.0.0                  # then FE 172.28.80.50
#   ... be v1.0.0 --create-only   build, migrate, create the container and its data volume WITHOUT
#                                 starting it (e.g. to restore a backup into the volume first, §13);
#                                 then `dc.sh be up -d`
#   ... be v1.0.0 --skip-migrate  leave the RDS schema alone (the app does not read RDS before Phase 1)
#
# Guarded: refuses when the checkout has local edits or the tag does not exist, keeps the
# running image as :prev (instant rollback, guide §12), builds on this server, (BE) applies
# the migrations, recreates the container (--force-recreate: Compose compares image NAMES,
# so a plain `up -d` after a rebuild keeps the old code) and checks it.
set -euo pipefail
ROLE="${1:-}"; TAG="${2:-}"
case "$ROLE" in be|fe) ;; *) echo "usage: release.sh be|fe <release tag> [--create-only] [--skip-migrate]" >&2; exit 2 ;; esac
[ -n "$TAG" ] && [ "${TAG#--}" = "$TAG" ] || { echo "usage: release.sh $ROLE <release tag, e.g. v1.0.0> [options]" >&2; exit 2; }
shift 2
MIGRATE=1; CREATE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-migrate) MIGRATE=0 ;;
    --create-only) CREATE_ONLY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

RUN="${ASTAR_RUN_DIR:-/opt/astar-erp}"
SRC="$RUN/src"
DC="$SRC/deploy/production/dc.sh $ROLE"
stop() { echo "STOP - $*" >&2; exit 1; }

# ── the filled-in runtime files must exist and be complete ──
need_filled() {
  [ -f "$RUN/$1" ] || stop "$RUN/$1 is missing (guide: copy it from deploy/production)"
  if grep -nE '^[^#]*FILL_' "$RUN/$1"; then stop "fill in the FILL_ values above in $RUN/$1"; fi
}
need_filled .env
if [ "$ROLE" = be ]; then
  need_filled production.env
  need_filled secrets.production.env
  ls "$RUN"/service-accounts/*.json >/dev/null 2>&1 || echo "WARNING: no Google key in $RUN/service-accounts - the sheet sync cannot run"
else
  need_filled fe-build.env
fi

# ── code: the release tag, in a checkout without local edits ──
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { git -C "$SRC" status -sb; stop "the code in $SRC has local changes"; }
git -C "$SRC" fetch --tags --force origin
git -C "$SRC" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || stop "release tag $TAG does not exist on GitHub (git tag -a $TAG <commit> && git push origin $TAG)"
git -C "$SRC" -c advice.detachedHead=false checkout -q "$TAG"
SHA=$(git -C "$SRC" rev-parse --short HEAD)
echo "Releasing $TAG ($SHA: $(git -C "$SRC" log -1 --format=%s | cut -c1-70))"

# ── build, keeping the running image for a rollback ──
if [ "$ROLE" = be ]; then
  IMAGE=astar-erp-backend; CONTAINER=astar-erp-backend
  docker image inspect "$IMAGE:production" >/dev/null 2>&1 && docker tag "$IMAGE:production" "$IMAGE:prev"
  docker build -t "$IMAGE:production" "$SRC/backend"
  if [ "$MIGRATE" = 1 ]; then
    echo "Applying RDS schema migrations..."
    $DC run --rm --no-deps backend node scripts/db-migrate.js
  fi
else
  IMAGE=astar-erp-frontend; CONTAINER=astar-erp-frontend
  BUILD_ARGS=()
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    BUILD_ARGS+=(--build-arg "$line")
  done < "$RUN/fe-build.env"
  docker image inspect "$IMAGE:production" >/dev/null 2>&1 && docker tag "$IMAGE:production" "$IMAGE:prev"
  # The release reported to DWS Hub / Sentinel is the tag's commit: Sentinel reads exactly that code.
  docker build "${BUILD_ARGS[@]}" --build-arg NGINX_CONFIG=production --build-arg "VITE_GIT_SHA=$SHA" -t "$IMAGE:production" "$SRC/frontend"
fi
if [ "$CREATE_ONLY" = 1 ]; then
  $DC create --force-recreate
  echo "Created $CONTAINER and its volume without starting them. Start them with: $DC up -d"
  exit 0
fi
$DC up -d --force-recreate

# ── check ──
status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 2
done
echo "Container $CONTAINER: $status"
if [ "$ROLE" = be ]; then
  BIND=$(grep -sE '^ASTAR_API_BIND=' "$RUN/.env" | cut -d= -f2); BIND="${BIND:-172.28.80.51:4150}"
  curl -fsS "http://$BIND/api/health" && echo
  curl -sS "http://$BIND/api/ready" && echo
else
  BIND=$(grep -sE '^ASTAR_WEB_BIND=' "$RUN/.env" | cut -d= -f2); BIND="${BIND:-172.28.80.50:3150}"
  curl -fsS "http://$BIND/healthz"
  curl -sS "http://$BIND/api/health" && echo
  curl -s "http://$BIND/" | grep -o 'data-release="[^"]*"' || echo "(no Hub SDK tag in the page - VITE_HUB_SDK_KEY empty?)"
fi
[ "$status" = healthy ] || { docker logs --tail 40 "$CONTAINER" >&2; stop "$CONTAINER is not healthy (rollback: guide §12)"; }
echo "$CONTAINER is running $TAG. Instant rollback: docker tag $IMAGE:prev $IMAGE:production && $DC up -d --force-recreate"
