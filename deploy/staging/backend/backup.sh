#!/usr/bin/env bash
# Staging backend: consistent copies of the data that cannot be rebuilt from the
# spreadsheets (users and roles, Sheets Config, sign-in security, activity log).
# The DB1-DB17 mirrors are rebuilt by the sync and are not copied.
#
#   ./backup.sh            -> backups/<timestamp>/*.db, keeps the newest 14 sets
#   crontab: 30 1 * * * /opt/astar-erp/deploy/staging/backend/backup.sh >> /opt/astar-erp/deploy/staging/backend/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER=astar-erp-backend-staging
STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="backups/$STAMP"
mkdir -p "$TARGET"
chmod 700 backups

# SQLite online backup inside the container: safe while the app is writing (WAL mode).
docker exec "$CONTAINER" node -e "
  const Database = require('better-sqlite3');
  const fs = require('fs');
  fs.mkdirSync('/app/data/.backup', { recursive: true });
  (async () => {
    for (const name of ['erp.db', 'login_security.db', 'user_activity.db']) {
      if (!fs.existsSync('/app/data/' + name)) continue;
      const db = new Database('/app/data/' + name, { readonly: true });
      await db.backup('/app/data/.backup/' + name);
      db.close();
    }
  })().catch(error => { console.error(error.message); process.exit(1); });
"
docker cp "$CONTAINER:/app/data/.backup/." "$TARGET/"
docker exec "$CONTAINER" rm -rf /app/data/.backup
chmod 600 "$TARGET"/*.db
echo "$(date -Is) backup written to $TARGET: $(ls "$TARGET" | tr '\n' ' ')"

# Keep the newest 14 sets.
ls -1d backups/20* 2>/dev/null | sort | head -n -14 | xargs -r rm -rf
