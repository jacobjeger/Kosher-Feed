#!/usr/bin/env node
/**
 * Import production data from Replit SQL export into Railway Postgres.
 * Imports: categories, feeds, feed_categories, admin_users, sponsors, subscriptions
 * Skips: episodes (auto-sync), favorites, playback_positions, episode_listens, etc.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/import-production-data.js path/to/shiurpod_production_export.sql
 */

const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;
const sqlFile = process.argv[2];

if (!DATABASE_URL) {
  console.error("ERROR: Set DATABASE_URL env var");
  console.error('Usage: DATABASE_URL="postgresql://..." node scripts/import-production-data.js export.sql');
  process.exit(1);
}

if (!sqlFile || !fs.existsSync(sqlFile)) {
  console.error("ERROR: SQL file not found:", sqlFile || "(none provided)");
  process.exit(1);
}

// Tables to import, in dependency order
const IMPORT_TABLES = [
  "categories",
  "feeds",
  "feed_categories",
  "admin_users",
  "sponsors",
  "subscriptions",
];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("Connected to database");

  const content = fs.readFileSync(sqlFile, "utf-8");
  const lines = content.split("\n");

  for (const table of IMPORT_TABLES) {
    const statements = [];
    let deleteStmt = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === `DELETE FROM ${table};`) {
        deleteStmt = trimmed;
      } else if (trimmed.startsWith(`INSERT INTO ${table} `)) {
        statements.push(trimmed);
      }
    }

    if (statements.length === 0) {
      console.log(`  ${table}: no data found, skipping`);
      continue;
    }

    console.log(`  ${table}: ${statements.length} rows...`);

    // Delete existing data
    if (deleteStmt) {
      try {
        await client.query(deleteStmt);
      } catch (e) {
        console.log(`    Warning on DELETE: ${e.message}`);
      }
    }

    // Insert rows one by one (handles any individual failures)
    let ok = 0, fail = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 3) console.log(`    Error: ${e.message.substring(0, 120)}`);
      }
    }
    console.log(`    Done: ${ok} inserted, ${fail} failed`);
  }

  await client.end();
  console.log("\nImport complete!");
  console.log("Episodes will auto-populate when the server runs feed sync.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
