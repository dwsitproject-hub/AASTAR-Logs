# Apps Script Sheet Sync

This trigger is the inbound half of the quota-efficient Sheet sync. ERP reads
come from SQLite and ERP writes use the service-account Sheets API. Apps Script
only reports edits made directly by a human in Google Sheets.

1. Add `AppsScriptSheetSync.gs` to the spreadsheet's existing Apps Script project.
2. In **Project Settings > Script Properties**, set (preferred):
   - `ERP_SYNC_URL` to `https://erp-aastar-trading-sg.trade/api/test/apps-script-sheet/events`
   - `ERP_SYNC_SECRET` to the same value as the VPS `APPS_SCRIPT_TEST_SECRET`.
   Existing projects may instead reuse a global `CONFIG.vpsEventsUrl` and
   `CONFIG.secret`; Script Properties take precedence when present.
3. Run `installErpSheetSync()` once and approve the requested permissions.
4. Share the spreadsheet as Editor with the service account configured by
   `APPS_SCRIPT_TEST_SERVICE_ACCOUNT_EMAIL` on the VPS.

The installer creates installable edit/change triggers, assigns UUIDs in hidden
column F, and hides that column. Existing `doGet` and `doPost` functions can stay
in place while the VPS uses them as a migration fallback.
