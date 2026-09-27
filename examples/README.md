# Examples — verifying seals offline

This directory contains everything you need to verify the seal chain **without
trusting LUU**, without making any network calls, on any machine with Node 18+.

## Files

| File               | Purpose                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sample-seal.json` | A real-format seal you can use to test the verifier. The `rootHash` is for illustration; it doesn't correspond to a real evidence pack.                                                                   |
| `walk-chain.mjs`   | Walks every `YYYY-MM-DD.json` seal in a directory and checks each seal's link against the chain as it stood when that seal was made — declared gaps pass, undeclared ones break. Zero deps, zero network. |
| `verify-inclusion.mjs` | Checks that one record is included under a root published here: re-hashes the record, folds its proof, fetches the root from this repository at the named commit, and reads GitHub's push time. Zero dependencies, Node 18+. The repository name is fixed in the script, never read from the file being checked. |

## Walk a chain

```bash
# The global chain (seals at daily-seals/ root)
node examples/walk-chain.mjs daily-seals/

# A single workspace sub-chain
node examples/walk-chain.mjs daily-seals/abc12345/
```

Output for an intact chain:

```
2026-09-16: leaves=15  root=952c0d44f66cbb9f...  ✓ linked
2026-09-17: leaves=6   root=757dc22a1ec47585...  ✓ linked
2026-09-21: leaves=63  root=e15404233990d613...  legacy gap: 3 day(s) with no seal since 2026-09-17; walk continues there

[walk-chain] OK — 162 seal(s), every link verified; 15 legacy gap(s); 1 note(s).
```

Add `--json` for a machine-readable result (`ok`, `counts`, `gaps`, `notes`,
`breaks`).

### The rule

Every seal is judged by the chain **as it stood when that seal was made** (its
`sealedAt`) — a seal can only link to what already existed.

- A seal with a `chain` block (from September 2026) declares its predecessor
  and the number of days in between with no seal. It passes when the root, the
  date and the day count all check out and no seal in between already existed.
- A seal without one is judged by the rule it was written under: its
  `previousDayRootHash` is the previous calendar day's root, or `null` when that
  day had no seal yet. That `null` is reported as a **legacy gap** and the walk
  continues from the most recent earlier seal.
- A **break** is anything else: a link to the wrong root (even one published
  elsewhere in the directory), an undeclared or miscounted gap, a `null` link
  while the previous day's seal already existed, a malformed `chain` block, or
  an old-format seal made after a new-format one.

```
[walk-chain] BREAK at 2026-09-21 (seal_chain_link_mismatch)
  previous root 6342e4cf6153… != 2026-09-17 root 757dc22a1ec4…

[walk-chain] FAIL — 1 genuine break(s) detected.
```

The earliest seal in a directory may link to a seal outside it when you verify a
partial window; that is reported as a boundary note, not a break. One historical
anomaly — the 2026-03-09 global seal, written with a `null` link by two
concurrent backfill runs — is disclosed in the script and accepted by its exact
root only.

This is the same rule the public `/credibility` page and the nightly integrity
sentinel apply server-side, so the three agree.

## Verify a specific evidence pack

The chain walk above proves the **seals** are internally consistent. To prove a
**specific decision** is committed to a specific seal, you also need the evidence
pack from the issuing tenant. The pack format is a canonical-JSON + Merkle
construction with **nothing proprietary** — the full contract is in
"Build your own verifier" below, and a reference TypeScript implementation lives
in the product repo at `lib/attestation/insightPackVerifier.ts` (imports only
Node's `crypto`). A standalone published npm CLI is planned but **not yet
released** — until it is, use the documented contract or the reference source;
do not assume an `@luu/*` package exists on npm.

Once you have a pack's expected `rootHash` and `dateKey`, look up
`daily-seals/<workspace-short>/<dateKey>.json` in this repository, confirm the
`rootHash` matches, and check that the Git commit which created or last touched
that seal file pre-dates whatever outcome you're auditing.

## Build your own verifier

The repository structure is documented enough to implement a verifier in any
language. The contract:

1. **Canonical JSON** — JSON keys sorted alphabetically at every depth, no
   whitespace, `Date` instances serialized as ISO 8601 strings.
2. **Leaf hash** — `sha256(canonicalJson(artifact))`.
3. **Pair hash** — sort the two child hashes lexicographically as hex strings,
   concatenate, and SHA-256 the result. Proofs are therefore symmetric — you
   don't need to know which child was on the left.
4. **Tree shape** — a complete binary Merkle tree. If a level has an odd number
   of leaves, the last leaf is duplicated.
5. **Merkle proof** — a list of sibling hashes from leaf to root. Fold them in:
   at each step, hash the current value with the next sibling using the pair-hash
   rule, until the result equals the recorded `rootHash`.

The algorithm is standard SHA-256 + sorted-concatenation Merkle. There's nothing
proprietary and nothing you have to take on trust.
