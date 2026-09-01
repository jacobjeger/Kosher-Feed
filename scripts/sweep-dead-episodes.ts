// Manual runner for the dead-episode sweep (server/dead-episodes.ts).
//
// The sweep also runs daily inside the server; this is for running it on
// demand and for seeing what it would do before letting it do it.
//
//   DATABASE_URL=... npx tsx scripts/sweep-dead-episodes.ts               # dry run
//   DATABASE_URL=... npx tsx scripts/sweep-dead-episodes.ts --apply
//   DATABASE_URL=... npx tsx scripts/sweep-dead-episodes.ts --apply --max=10
//
// A dry run makes exactly the same network probes and feed re-parses and
// records the same verdicts — it only skips the DELETE, logging "would remove"
// instead. Note that its verdicts still count for RECHECK_DAYS, so a dry run
// immediately followed by --apply will find nothing left to judge; wait out
// the window or clear the episode_health rows you want re-examined.

import { sweepDeadEpisodes } from "../server/dead-episodes";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const apply = process.argv.includes("--apply");
  const maxArg = process.argv.find((a) => a.startsWith("--max="));
  const maxRemovals = maxArg ? Number(maxArg.slice("--max=".length)) : undefined;

  console.log(apply ? "Running sweep (--apply: will delete)" : "Running sweep (dry run)");

  const s = await sweepDeadEpisodes({ dryRun: !apply, maxRemovals });

  console.log(
    `\ncandidates ${s.candidates} | probed ${s.probed} | ok ${s.ok} | ` +
      `transient ${s.transient} | orphaned ${s.orphaned} | ` +
      `${apply ? "removed" : "would remove"} ${s.removed} | skipped ${s.skipped}`,
  );
  if (!apply && s.removed > 0) console.log("Pass --apply to actually remove them.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
