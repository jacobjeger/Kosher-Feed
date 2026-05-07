#!/usr/bin/env bash
# Roll back the YTC Alumni integration. See .claude/plans/ytc-integration.md.
#
# Usage:
#   bash scripts/ytc-rollback.sh --dry-run    # print what would change, do nothing
#   bash scripts/ytc-rollback.sh              # actually delete files + git rm
#
# This script removes the QUARANTINED YTC code (everything under app/ytc/,
# lib/ytc/, etc.). It then prints — but does not auto-edit — every shared-
# file `// YTC:` marker that needs manual removal, and the SQL needed to
# clean up server-side state. Manual steps are kept manual on purpose:
# automatic mass-grep substitutions in shared files are how rollbacks
# corrupt repos.

set -euo pipefail

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; fi

run() {
  if [ "$DRY" = "1" ]; then
    echo "would: $*"
  else
    "$@"
  fi
}

cd "$(dirname "$0")/.."

echo "=== Step 1: delete quarantined YTC files ==="
QUARANTINED=(
  app/ytc                            # auth-gated subtree (Phase 4+)
  app/ytc-unlock.tsx                 # Phase 2 unlock modal
  lib/ytc                            # Phase 2 unlock + Phase 3 firebase + Phase 6 audio adapter
  contexts/YtcAuthContext.tsx        # Phase 4 auth provider
  constants/ytcColors.ts             # Phase 2 palette
  types/ytc.ts                       # Phase 2 type defs
)
for p in "${QUARANTINED[@]}"; do
  if [ -e "$p" ]; then
    run git rm -rf "$p"
  else
    echo "  (already absent: $p)"
  fi
done

echo ""
echo "=== Step 2: shared-file YTC: markers — REMOVE MANUALLY ==="
echo "Each match below is a code block guarded by // YTC: that needs to be"
echo "deleted. Open the file, find the marker, delete the marker through the"
echo "next blank line / end of block. This is intentionally manual."
echo ""
grep -rn --include='*.ts' --include='*.tsx' --include='*.html' "YTC:" \
  app contexts lib server 2>/dev/null \
  | grep -vE "^\s*$|node_modules|\.git/" \
  || echo "  (no markers found — quarantine cleanup may be complete)"

echo ""
echo "=== Step 3: drop firebase npm dependency ==="
if grep -q '"firebase"' package.json 2>/dev/null; then
  if [ "$DRY" = "1" ]; then
    echo "would: npm uninstall firebase"
  else
    npm uninstall firebase
  fi
else
  echo "  (firebase not in package.json — already gone)"
fi

echo ""
echo "=== Step 4: server-side cleanup (run manually in psql) ==="
cat <<'SQL'
  -- Remove admin-managed config rows
  DELETE FROM app_config WHERE key LIKE 'ytc_%';

  -- Drop the device-link mapping table (only exists if Phase 7 / v1.1
  -- notifications shipped; safe to run unconditionally).
  DROP TABLE IF EXISTS ytc_device_links;
SQL

echo ""
echo "=== Step 5: rebuild + ship OTA ==="
echo "After verifying the manual edits above:"
echo "  git diff --stat                      # confirm only YTC: blocks removed"
echo "  npx tsc --noEmit -p tsconfig.json    # type-check passes"
echo "  npx eas update --channel production  # ship the rollback"
echo ""
if [ "$DRY" = "1" ]; then
  echo "DRY RUN — no files were modified."
else
  echo "Rollback step 1 (file deletion) is complete. Steps 2–5 are manual."
fi
