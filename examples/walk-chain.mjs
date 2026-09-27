#!/usr/bin/env node
/**
 * walk-chain.mjs — verify the linkage of a set of daily seals, offline.
 *
 * Reads every YYYY-MM-DD.json file in one directory — one chain: the repo-root
 * `daily-seals/` for the global chain, or one `daily-seals/<workspace>/`
 * sub-directory — and judges every seal's link to the seal before it.
 *
 * This script makes ZERO network calls and has ZERO dependencies beyond Node's
 * standard library. It runs purely on local files — the whole point is that
 * anyone can verify the chain offline, without trusting us or running our code.
 *
 * THE RULE (identical to lib/forwardTesting/sealChain.ts in the source repo,
 * held to it by a parity test). Every seal is judged by the chain AS IT STOOD
 * WHEN THAT SEAL WAS MADE (its `sealedAt`), because a seal can only link to what
 * already existed.
 *
 *   Seals carrying a `chain` block (chain v2, from 2026-09) declare their link:
 *     { "version": 2, "previousSealDateKey": "2026-09-17", "gapDays": 3 }
 *   means "this seal links to the 2026-09-17 seal, and the 3 calendar days in
 *   between had no seal when this one was made". It passes when the root, the
 *   date and the day count all check out and no seal in between already
 *   existed. A missing day is then an attested fact, not a hole.
 *
 *   Seals without a `chain` block (legacy) are judged by the rule they were
 *   written under: `previousDayRootHash` is the previous CALENDAR day's root,
 *   or null when that day had no seal at sealing time. Such a null is the only
 *   way the old format could say "no seal", so it is accepted — reported as a
 *   legacy gap — and the walk continues from the most recent earlier seal.
 *
 *   BREAKS: an undeclared gap (a null link, or a genesis claim, while an earlier
 *   seal already existed; a link that skips an existing seal), a link to the
 *   wrong root, a declared predecessor that is not here, a miscounted gap, a
 *   malformed `chain` block, or a legacy-format seal made after a v2 one.
 *
 *   ONE pinned historical anomaly is accepted and printed (KNOWN_ANOMALIES
 *   below), matched by its exact root. Nothing else is excused.
 *
 *   WINDOWS: if you point this at a partial copy of a chain, the EARLIEST seal
 *   in the directory may link to a seal that is not in it. That is reported as
 *   a boundary note, not a break. Every other link must resolve.
 *
 * Usage:
 *   node walk-chain.mjs ../daily-seals/            # global chain (repo root seals)
 *   node walk-chain.mjs ../daily-seals/abc12345/   # a single workspace sub-chain
 *   node walk-chain.mjs ../daily-seals/ --json     # machine-readable result
 *   node walk-chain.mjs                            # default: ./
 *
 * Exit codes: 0 = OK (no genuine breaks), 1 = break(s) detected, 2 = no seals.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const dir = args.find((a) => !a.startsWith("--")) ?? ".";
const fileRe = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Historical link defects that are understood, disclosed, and cannot be
 * repaired without rewriting an anchored seal. Matched by exact root.
 */
const KNOWN_ANOMALIES = [
  {
    dateKey: "2026-03-09",
    rootHash:
      "3fee6eecd2a5dd1a98bbfcd1e9b03f2395349b7c605b931f3eee705951d2f8fd",
    evidence:
      "global chain: two backfill runs sealed 2026-03-07..09 concurrently on " +
      "2026-03-10; the 03-09 run looked up its previous-day seal before the " +
      "03-08 seal committed (7s earlier) and wrote a NULL link. Both roots are " +
      "independently anchored. The race has since been closed by a job lock.",
  },
];

function dayNumber(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function daysBetween(fromKey, toKey) {
  return dayNumber(toKey) - dayNumber(fromKey);
}
function previousDateKey(dateKey) {
  return new Date((dayNumber(dateKey) - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
}
function short(h) {
  return typeof h === "string" && h ? `${h.slice(0, 12)}…` : "null";
}

/** { kind: "absent" } | { kind: "v2", decl } | { kind: "malformed", reason } */
function readChain(value) {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", reason: "chain is not an object" };
  }
  if (value.version !== 2) {
    return {
      kind: "malformed",
      reason: `unsupported chain version ${String(value.version)}`,
    };
  }
  const prev = value.previousSealDateKey;
  const gap = value.gapDays;
  if (prev === null) {
    if (gap !== null) {
      return {
        kind: "malformed",
        reason: "genesis declaration carries gapDays",
      };
    }
    return { kind: "v2", decl: { previousSealDateKey: null, gapDays: null } };
  }
  if (typeof prev !== "string" || !DATE_KEY_RE.test(prev)) {
    return { kind: "malformed", reason: "previousSealDateKey is not a date" };
  }
  if (typeof gap !== "number" || !Number.isInteger(gap) || gap < 0) {
    return {
      kind: "malformed",
      reason: "gapDays is not a non-negative integer",
    };
  }
  return { kind: "v2", decl: { previousSealDateKey: prev, gapDays: gap } };
}

let names;
try {
  names = (await readdir(dir))
    .filter((f) => fileRe.test(f))
    .sort((a, b) => a.localeCompare(b));
} catch {
  names = [];
}

if (names.length === 0) {
  console.error(`[walk-chain] no seal files found in ${dir}`);
  process.exit(2);
}

const seals = [];
for (const name of names) {
  const s = JSON.parse(await readFile(join(dir, name), "utf-8"));
  seals.push({
    dateKey: name.replace(".json", ""),
    rootHash: s.rootHash,
    previousDayRootHash: s.previousDayRootHash ?? null,
    sealedAtMs: Date.parse(s.sealedAt),
    leafCount: s.leafCount,
    chain: s.chain ?? null,
  });
}
const byDate = new Map(seals.map((s) => [s.dateKey, s]));

const breaks = [];
const notes = [];
const gaps = [];
const counts = {
  genesis: 0,
  linked: 0,
  declared_gap: 0,
  legacy_genesis: 0,
  legacy_linked: 0,
  legacy_gap: 0,
  legacy_predecessor_sealed_later: 0,
  known_anomaly: 0,
  boundary: 0,
};
const lines = [];

seals.forEach((s, idx) => {
  let verdict = "";
  const fail = (kind, detail) => {
    breaks.push({ dateKey: s.dateKey, kind, detail });
    verdict = `BREAK (${kind})`;
  };
  const isEarliest = idx === 0;

  if (typeof s.rootHash !== "string" || !/^[0-9a-f]{64}$/.test(s.rootHash)) {
    breaks.push({
      dateKey: s.dateKey,
      kind: "bad_root_hash",
      detail: `BAD root hash: ${s.rootHash}`,
    });
    lines.push(`${s.dateKey}: BAD root hash`);
    return;
  }

  // The chain as it stood when `s` was made. Unknown timestamps count as
  // "existed" — the conservative reading, which can only produce a break.
  let atSealTime = null;
  for (let j = idx - 1; j >= 0; j--) {
    if (!(seals[j].sealedAtMs >= s.sealedAtMs)) {
      atSealTime = seals[j];
      break;
    }
  }

  const read = readChain(s.chain);
  if (read.kind === "malformed") {
    fail("seal_chain_declaration_malformed", read.reason);
  } else if (read.kind === "v2") {
    const { decl } = read;
    if (decl.previousSealDateKey === null) {
      if (s.previousDayRootHash) {
        fail(
          "seal_chain_link_mismatch",
          "declares genesis but carries a previous root",
        );
      } else if (atSealTime) {
        fail(
          "seal_chain_gap_undeclared",
          `declares genesis, but the ${atSealTime.dateKey} seal already existed`,
        );
      } else {
        counts.genesis++;
        verdict = "genesis";
      }
    } else {
      const declared = byDate.get(decl.previousSealDateKey);
      if (!declared) {
        if (isEarliest) {
          counts.boundary++;
          notes.push(
            `earliest seal ${s.dateKey} links to ${decl.previousSealDateKey}, which is not in this directory — expected at a window boundary`,
          );
          verdict = "boundary";
        } else {
          fail(
            "seal_chain_predecessor_missing",
            `declared predecessor ${decl.previousSealDateKey} is not in the chain`,
          );
        }
      } else if (s.previousDayRootHash !== declared.rootHash) {
        fail(
          "seal_chain_link_mismatch",
          `previous root ${short(s.previousDayRootHash)} != ${decl.previousSealDateKey} root ${short(declared.rootHash)}`,
        );
      } else if (
        decl.gapDays !==
        daysBetween(decl.previousSealDateKey, s.dateKey) - 1
      ) {
        fail(
          "seal_chain_gap_misdeclared",
          `declares gapDays=${decl.gapDays}; the calendar says ${daysBetween(decl.previousSealDateKey, s.dateKey) - 1}`,
        );
      } else if (!atSealTime || atSealTime.dateKey < declared.dateKey) {
        fail(
          "seal_chain_link_mismatch",
          `links to ${declared.dateKey}, which was sealed after this seal`,
        );
      } else if (atSealTime.dateKey !== declared.dateKey) {
        fail(
          "seal_chain_gap_undeclared",
          `links to ${declared.dateKey}, but the ${atSealTime.dateKey} seal already existed`,
        );
      } else if (decl.gapDays > 0) {
        counts.declared_gap++;
        gaps.push({
          dateKey: s.dateKey,
          previousSealDateKey: declared.dateKey,
          gapDays: decl.gapDays,
          declared: true,
        });
        verdict = `✓ linked to ${declared.dateKey} (declared gap: ${decl.gapDays} day(s) with no seal)`;
      } else {
        counts.linked++;
        verdict = "✓ linked";
      }
    }
  } else if (atSealTime && readChain(atSealTime.chain).kind === "v2") {
    fail(
      "seal_chain_legacy_after_v2",
      `legacy-format seal made after the v2 seal of ${atSealTime.dateKey}`,
    );
  } else {
    const prevDay = byDate.get(previousDateKey(s.dateKey));
    if (s.previousDayRootHash) {
      if (prevDay && prevDay.rootHash === s.previousDayRootHash) {
        counts.legacy_linked++;
        verdict = "✓ linked";
      } else if (!prevDay && isEarliest) {
        counts.boundary++;
        notes.push(
          `earliest seal ${s.dateKey} chains to a predecessor root (${short(s.previousDayRootHash)}) not in this directory — expected at a window/lineage boundary`,
        );
        verdict = "boundary";
      } else {
        fail(
          "seal_chain_link_mismatch",
          prevDay
            ? `previousDayRootHash ${short(s.previousDayRootHash)} != previous day's root ${short(prevDay.rootHash)}`
            : `previousDayRootHash ${short(s.previousDayRootHash)} — no published seal for the previous day`,
        );
      }
    } else if (prevDay && !(prevDay.sealedAtMs >= s.sealedAtMs)) {
      const known = KNOWN_ANOMALIES.find(
        (a) => a.dateKey === s.dateKey && a.rootHash === s.rootHash,
      );
      if (known) {
        counts.known_anomaly++;
        notes.push(`known anomaly at ${s.dateKey}: ${known.evidence}`);
        verdict = "known anomaly (see note)";
      } else {
        fail(
          "seal_chain_gap_undeclared",
          `NULL link, but the previous day's seal (${prevDay.dateKey}) already existed`,
        );
      }
    } else if (prevDay) {
      counts.legacy_predecessor_sealed_later++;
      verdict = "no link (the previous day was sealed later)";
    } else if (atSealTime) {
      const gapDays = daysBetween(atSealTime.dateKey, s.dateKey) - 1;
      counts.legacy_gap++;
      gaps.push({
        dateKey: s.dateKey,
        previousSealDateKey: atSealTime.dateKey,
        gapDays,
        declared: false,
      });
      verdict = `legacy gap: ${gapDays} day(s) with no seal since ${atSealTime.dateKey}; walk continues there`;
    } else {
      counts.legacy_genesis++;
      verdict = "first seal";
    }
  }

  lines.push(
    `${s.dateKey}: leaves=${s.leafCount}  root=${s.rootHash.slice(0, 16)}...  ${verdict}`,
  );
});

const ok = breaks.length === 0;

if (JSON_MODE) {
  console.log(
    JSON.stringify(
      { ok, seals: seals.length, counts, gaps, notes, breaks },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

for (const line of lines) console.log(line);
for (const n of notes) console.log(`[walk-chain] note: ${n}`);
for (const b of breaks) {
  console.error(
    `[walk-chain] BREAK at ${b.dateKey} (${b.kind})\n  ${b.detail}`,
  );
}

if (ok) {
  const declared = gaps.filter((g) => g.declared).length;
  const legacy = gaps.length - declared;
  console.log(
    `\n[walk-chain] OK — ${seals.length} seal(s), every link verified` +
      (declared ? `; ${declared} declared gap(s)` : "") +
      (legacy ? `; ${legacy} legacy gap(s)` : "") +
      (notes.length ? `; ${notes.length} note(s)` : "") +
      ".",
  );
  process.exit(0);
}

console.error(
  `\n[walk-chain] FAIL — ${breaks.length} genuine break(s) detected.`,
);
process.exit(1);
