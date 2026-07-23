# Examples — verifying seals offline

This directory contains everything you need to verify the seal chain **without
trusting LUU**, without making any network calls, on any machine with Node 18+.

## Files

| File               | Purpose                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sample-seal.json` | A real-format seal you can use to test the verifier. The `rootHash` is for illustration; it doesn't correspond to a real evidence pack.                          |
| `walk-chain.mjs`   | Walks every `YYYY-MM-DD.json` seal in a directory and asserts each one's `previousDayRootHash` resolves to a real published `rootHash`. Zero deps, zero network. |

## Walk a chain

```bash
# The global chain (seals at daily-seals/ root)
node examples/walk-chain.mjs daily-seals/

# A single workspace sub-chain
node examples/walk-chain.mjs daily-seals/abc12345/
```

Output for an intact chain (a link that resolves to a published predecessor is
marked `✓ linked`):

```
2026-07-20: leaves=172  root=3ead1688680c9230...  ✓ linked
2026-07-21: leaves=123  root=74ee51f6c97d2c8a...  ✓ linked
2026-07-22: leaves=58   root=6bbaaf2a9d9a1f12...  ✓ linked

[walk-chain] OK — 26 seal(s), every link resolves to a published root (1 boundary note).
```

The "boundary note" is the earliest seal in the directory: it legitimately
chains to a root published in an earlier window (or the pre-multitenancy global
chain), so its predecessor isn't in this directory. That is expected, not a
break.

If a seal has been tampered with — so that the next day's `previousDayRootHash`
no longer resolves to any published root — you get a clear break and a non-zero
exit code:

```
[walk-chain] BREAK at 2026-07-20
  previousDayRootHash: 74ee51f6...<the altered predecessor>
  no published seal has that rootHash (dropped/unpublished predecessor).

[walk-chain] FAIL — 1 genuine break(s) detected.
```

### Why existence-based, not file-adjacent

Seals are only produced on days the sealing job ran, and the global chain and
each workspace chain are separate lineages. A naive check that compares each
file to the immediately-preceding file would report a "break" across any gap or
lineage boundary — a false alarm, not a real integrity failure. `walk-chain.mjs`
instead builds the set of all published roots and verifies that every
`previousDayRootHash` points into it. This is the same check the public
`/credibility` page runs server-side, so the two agree.

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
