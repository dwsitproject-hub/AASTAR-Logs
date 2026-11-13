#!/usr/bin/env bash
# Production backend (172.28.80.51): consistent copies of the data that cannot be
# rebuilt from the spreadsheets - users and roles, Sheets Config and its history,
# sign-in security, activity log. The DB1-DB17 mirrors are rebuilt by the sync.
#
#   /opt/astar-erp/src/deploy/production/backup.sh      -> /opt/astar-erp/backups/<timestamp>/*.db, newest 30 kept
#   cron (guide §13):  30 1 * * * /opt/astar-erp/src/deploy/production/backup.sh >> /opt/astar-erp/backups/backup.log 2>&1
set -euo pipefail
CONTAINER="${CONTAINER:-astar-erp-backend}"
BACKUP_DIR="${BACKUP_DIR:-/opt/astar-erp/backups}"
KEEP="${KEEP:-30}"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR/$STAMP"
chmod 700 "$BACKUP_DIR"

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
docker cp "$CONTAINER:/app/data/.backup/." "$BACKUP_DIR/$STAMP/"
docker exec "$CONTAINER" rm -rf /app/data/.backup
chmod 600 "$BACKUP_DIR/$STAMP"/*.db
echo "$(date -Is) backup written to $BACKUP_DIR/$STAMP: $(ls "$BACKUP_DIR/$STAMP" | tr '\n' ' ')"

ls -1d "$BACKUP_DIR"/20* 2>/dev/null | sort | head -n "-$KEEP" | xargs -r rm -rf
