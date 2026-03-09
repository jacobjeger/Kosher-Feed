#!/bin/bash
# Import production data into Railway Postgres (without episodes)
# Usage: DATABASE_URL="postgres://..." bash scripts/import-production-data.sh

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: Set DATABASE_URL environment variable"
  echo "Usage: DATABASE_URL=\"postgres://...\" bash scripts/import-production-data.sh"
  exit 1
fi

SQL_FILE="/tmp/shiurpod_production_export.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "ERROR: SQL file not found at $SQL_FILE"
  echo "Run: git show origin/sql-exports:shiurpod_production_export.sql > /tmp/shiurpod_production_export.sql"
  exit 1
fi

echo "=== Importing production data (without episodes) ==="

# Extract lines 1-1096 (everything before push_tokens, which starts episode-dependent data)
# This includes: categories, feeds, feed_categories, admin_users, sponsors, subscriptions, favorites, playback_positions
# But we need to skip DELETE FROM for tables that reference episodes (favorites, playback_positions, episode_listens)
# Actually favorites and playback_positions reference episodes, so they'll fail on a fresh DB without episodes.
# Let's only import: categories, feeds, feed_categories, admin_users, sponsors, subscriptions

echo "Importing categories..."
sed -n '4,10p' "$SQL_FILE" | psql "$DATABASE_URL"

echo "Importing feeds..."
sed -n '11,434p' "$SQL_FILE" | psql "$DATABASE_URL"

echo "Importing feed_categories..."
sed -n '435,439p' "$SQL_FILE" | psql "$DATABASE_URL"

echo "Importing admin_users..."
sed -n '440,443p' "$SQL_FILE" | psql "$DATABASE_URL"

echo "Importing sponsors..."
sed -n '444,447p' "$SQL_FILE" | psql "$DATABASE_URL"

echo "Importing subscriptions..."
sed -n '448,587p' "$SQL_FILE" | psql "$DATABASE_URL"

echo ""
echo "=== Done! ==="
echo "Imported: categories, feeds, feed_categories, admin_users, sponsors, subscriptions"
echo "Skipped: episodes (will auto-sync), favorites, playback_positions, push_tokens, episode_listens, feedback, error_reports"
echo ""
echo "Episodes will populate automatically when the server starts and runs feed sync."
