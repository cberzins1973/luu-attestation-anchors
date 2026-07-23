#!/usr/bin/env node
/**
 * walk-chain.mjs — verify the linkage integrity of a set of daily seals.
 *
 * Reads every YYYY-MM-DD.json file in the given directory and asserts that each
 * seal's `previousDayRootHash` resolves to a real published seal's `rootHash`.
 * Reports genuine breaks (a claimed predecessor that isn't present) distinctly
 * from benign boundaries (the earliest seal chaining to history published
 * elsewhere, or a day the sealing job didn't run).
 *
 * This script makes ZERO network calls and has ZERO dependencies beyond Node's
 * standard library. It runs purely on local files — the whole point is that
 * anyone can verify the chain offline, without trusting us or running our code.
 *
 * WHY EXISTENCE-BASED, NOT FILE-ADJACENT:
 *   A naive check compares each file against the immediately-preceding file in
 *   sorted order. But seals are only produced on days the job ran, and the
 *   global chain and per-workspace chains are separate lineages. Comparing
 *   adjacent files across a gap or across lineages reports a "break" that is not
 *   a real integrity failure. Instead we build the set of all published roots
 *   and check that every non-null previousDayRootHash points into it. A tampered
 *   or dropped predecessor is a genuine break; an interleaved lineage is not.
 *   (This mirrors the server-side chain check on the public /credibility page,
 *   so the two agree.)
 *
 * Usage:
 *   node walk-chain.mjs ../daily-seals/            # global chain (repo root seals)
 *   node walk-chain.mjs ../daily-seals/abc12345/   # a single workspace sub-chain
 *   node walk-chain.mjs                            # default: ./
 *
 * Exit codes: 0 = OK (no genuine breaks), 1 = break(s) detected, 2 = no seals.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const dir = process.argv[2] ?? ".";
const dateRe = /^(\d{4}-\d{2}-\d{2})\.json$/;

const names = (await readdir(dir))
  .filter((f) => dateRe.test(f))
  .sort((a, b) => a.localeCompare(b));

if (names.length === 0) {
  console.error(`[walk-chain] no seal files found in ${dir}`);
  process.exit(2);
}

// Load every seal, then index all published roots.
const seals = [];
for (const name of names) {
  const seal = JSON.parse(await readFile(join(dir, name), "utf-8"));
  seals.push({ dateKey: name.replace(".json", ""), ...seal });
}
const publishedRoots = new Set(
  seals
    .map((s) => s.rootHash)
    .filter((r) => typeof r === "string" && r.length === 64),
);

let breaks = 0;
let notes = 0;

for (let i = 0; i < seals.length; i++) {
  const s = seals[i];

  if (typeof s.rootHash !== "string" || s.rootHash.length !== 64) {
    console.error(`[walk-chain] BAD root hash in ${s.dateKey}: ${s.rootHash}`);
    breaks++;
    continue;
  }

  const prev = s.previousDayRootHash;
  if (prev) {
    if (publishedRoots.has(prev)) {
      // Verified: this seal links to a real published predecessor.
    } else if (i === 0) {
      // Earliest seal in THIS directory: it legitimately chains to a root
      // published elsewhere (an earlier window, or the pre-multitenancy global
      // chain). Not a break.
      console.log(
        `[walk-chain] note: earliest seal ${s.dateKey} chains to a predecessor ` +
          `root (${prev.slice(0, 16)}...) not in this directory — expected at a ` +
          `window/lineage boundary.`,
      );
      notes++;
    } else {
      // Interior seal whose claimed predecessor is not published here. This is a
      // genuine gap in the published record — surfaced honestly as a break.
      console.error(
        `[walk-chain] BREAK at ${s.dateKey}\n` +
          `  previousDayRootHash: ${prev}\n` +
          `  no published seal has that rootHash (dropped/unpublished predecessor).`,
      );
      breaks++;
    }
  }

  console.log(
    `${s.dateKey}: leaves=${s.leafCount}  root=${s.rootHash.slice(0, 16)}...` +
      (prev && publishedRoots.has(prev) ? "  ✓ linked" : ""),
  );
}

if (breaks === 0) {
  console.log(
    `\n[walk-chain] OK — ${seals.length} seal(s), every link resolves to a ` +
      `published root${notes ? ` (${notes} boundary note${notes > 1 ? "s" : ""})` : ""}.`,
  );
  process.exit(0);
}

console.error(`\n[walk-chain] FAIL — ${breaks} genuine break(s) detected.`);
process.exit(1);
