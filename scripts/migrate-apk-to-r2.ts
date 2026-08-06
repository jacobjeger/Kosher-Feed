// Move APK builds out of Postgres and onto R2.
//
//   npx tsx scripts/migrate-apk-to-r2.ts --dry-run   # show what would happen
//   npx tsx scripts/migrate-apk-to-r2.ts
//
// Storing a 51MB APK as base64 cost ~67MB in the database AND loaded the whole
// build into the server's memory on every download. R2 does neither: the
// download becomes a 302 to the CDN edge.
//
// Deliberately conservative. For each APK it uploads first, verifies the stored
// object byte-for-byte against the database copy, and only then clears
// file_data. If verification fails the row is left exactly as it was, so the
// site keeps serving the old path.

import { eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { apkUploads } from "@shared/schema";
import { putObject, headObject, getObjectBuffer, publicUrl, isR2Configured } from "../server/r2";

const DRY = process.argv.includes("--dry-run");

async function dbSize(): Promise<string> {
  const r: any = await db.execute(sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`);
  return r.rows[0].s;
}

async function ensureSchema() {
  await db.execute(sql.raw(`ALTER TABLE apk_uploads ADD COLUMN IF NOT EXISTS r2_key TEXT`));
  await db.execute(sql.raw(`ALTER TABLE apk_uploads ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0 NOT NULL`));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS apk_download_stats (
      day TEXT NOT NULL, apk_id VARCHAR NOT NULL, count INTEGER DEFAULT 0 NOT NULL
    )`));
  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS apk_download_stats_day_apk_idx ON apk_download_stats (day, apk_id)`));
}

async function main() {
  if (!isR2Configured()) throw new Error("R2 is not configured — set R2_* env vars");

  await ensureSchema();
  console.log(`database before: ${await dbSize()}\n`);

  // Pull metadata only. Selecting file_data for every row at once would put
  // every APK in memory simultaneously — the exact problem being fixed.
  const rows: any = await db.execute(sql`
    SELECT id, version, original_name, file_size, is_active, r2_key,
           length(file_data) AS b64_len
      FROM apk_uploads ORDER BY created_at DESC
  `);

  if (!rows.rows?.length) {
    console.log("no APK rows to migrate");
    return;
  }

  for (const row of rows.rows) {
    const label = `${row.version || "(no version)"}${row.is_active ? " [ACTIVE]" : ""}`;

    if (row.r2_key) {
      console.log(`skip  ${label} — already on R2 (${row.r2_key})`);
      continue;
    }
    if (!row.b64_len) {
      console.log(`skip  ${label} — no file_data to migrate`);
      continue;
    }

    const mb = Math.round(Number(row.b64_len) / 1048576);
    if (DRY) {
      console.log(`would migrate ${label} — ${mb}MB base64 -> R2`);
      continue;
    }

    console.log(`migrating ${label} (${mb}MB base64)…`);

    // One row at a time, so peak memory is one APK rather than all of them.
    const one: any = await db.execute(sql`SELECT file_data FROM apk_uploads WHERE id = ${row.id}`);
    const buf = Buffer.from(one.rows[0].file_data, "base64");

    const safeName = String(row.original_name || "shiurpod.apk").replace(/[^A-Za-z0-9._-]/g, "-");
    const key = `apk/${safeName}`;

    await putObject(key, buf, "application/vnd.android.package-archive", {
      downloadFilename: safeName,
      cacheControl: "public, max-age=31536000, immutable",
    });

    // Verify against the bucket before trusting it. Size first (cheap), then a
    // full byte comparison — an APK that downloads corrupt is worse than one
    // that costs database space.
    const head = await headObject(key);
    if (!head.exists || head.size !== buf.length) {
      console.error(`  FAILED: stored ${head.size} bytes, expected ${buf.length} — leaving row untouched`);
      continue;
    }
    const roundTrip = await getObjectBuffer(key);
    if (!roundTrip.equals(buf)) {
      console.error(`  FAILED: byte comparison mismatch — leaving row untouched`);
      continue;
    }

    await db
      .update(apkUploads)
      .set({ r2Key: key, fileData: null })
      .where(eq(apkUploads.id, row.id));

    console.log(`  ok — ${head.size} bytes verified at ${publicUrl(key)}`);
  }

  if (!DRY) {
    // Reclaim the TOAST pages the base64 occupied.
    await db.execute(sql.raw(`VACUUM FULL apk_uploads`));
    console.log(`\ndatabase after:  ${await dbSize()}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("migration failed:", e);
    process.exit(1);
  });
