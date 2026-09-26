# luu-attestation-anchors

Daily Merkle roots of the sealed record kept by [Leadership Under Uncertainty](https://leadershipunderuncertainty.org), a research programme on how AI systems make and revise judgments. Each file publishes the root of one day's tree of record fingerprints, for the programme as a whole (`daily-seals/YYYY-MM-DD.json`) or for one scope (`daily-seals/<scope>/YYYY-MM-DD.json`). The files carry roots and tree shapes only. No record content is published here.

The contents of this repository are dedicated to the public domain under [CC0 1.0](LICENSE).

## Check that a record is included

A proof document names a record, the fingerprints that join it to a daily root, and the file and commit in this repository where that root was published. To check one with Node 18 or later and no other dependencies:

```bash
node examples/verify-inclusion.mjs record-and-proof.json
```

The script re-hashes the record, folds the proof to a root, fetches the published file from this repository at the named commit, and asks GitHub whether that commit is on `main` and when it was pushed. It takes the repository name from its own source, never from the file it is checking. Example proof documents, and the same check running in a browser, are at <https://leadershipunderuncertainty.org/credibility#offline>.

## Walk the chain

Each daily file names the previous day's root. To confirm that every link resolves to a root published here:

```bash
node examples/walk-chain.mjs daily-seals/
```

See [examples/README.md](examples/README.md) for scope sub-chains and sample output.

## What the files can and cannot show

- **Membership only.** A proof shows that a record's fingerprint is one of the leaves under a published root.
- **Not position or count.** Each pair of fingerprints is sorted before it is hashed, and leaves are hashed the same way as the nodes above them, so a proof binds neither where a record sits in the tree nor how many records the tree holds. Comparing the proof's length with the published depth is the check this construction allows.
- **Self-asserted dates.** Commits are unsigned, and the dates inside the files and commits are the programme's own.
- **One outside clock.** GitHub's record of when a commit was pushed is the only time the programme does not control. It is an upper bound: a record existed no later than the push that published its root.
- **Late publication.** The repository was created on 31 May 2026. Files dated January to April 2026 were first committed on 28 July 2026, so for those days the outside clock can only date the record to late July.
