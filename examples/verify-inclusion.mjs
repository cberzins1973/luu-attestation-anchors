#!/usr/bin/env node
// Check that a sealed record is included under a root published on GitHub.
// Zero dependencies. Node 18 or later. Public domain (CC0).
//   node verify-inclusion.mjs record-and-proof.json
// Exit codes: 0 included, 1 mismatch or untrusted coordinates, 2 network or parse error.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// sorted keys, then JSON (the programme's older recipe, "v1_forecast")
const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    : v;
export const canonicalizeV1Forecast = (v) => JSON.stringify(sortKeys(v));

// RFC 8785 JSON Canonicalization Scheme ("jcs_v1"), for plain JSON input
export function canonicalizeJcs(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? (v === 0 ? "0" : String(v)) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalizeJcs).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJcs(v[k])}`).join(",")}}`;
}

// the record names its own recipe inside the hashed bytes
export const recipeOf = (content) =>
  content?._identity?.hashRecipe === "jcs_v1" ? "jcs_v1" : "v1_forecast";
export const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// each pair is sorted, concatenated as hex text and hashed
export const fold = (leaf, siblings) =>
  siblings.reduce((node, s) => sha256Hex([node, s].sort().join("")), leaf);

const short = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const yes = (b) => (b ? "yes" : "no");

// The trust anchor is fixed here, never read from the file being checked:
// a proof file could otherwise name any repository, or a commit that exists
// only in a fork, and "verify" against a root its author wrote.
export const ANCHORS_REPO = "cberzins1973/luu-attestation-anchors";
export const ANCHORS_BRANCH = "main";
const TIMEOUT_MS = 10000;

// Checks the coordinates in the file against the pinned anchor. Returns a
// reason string when they do not fit, or null when they do.
export function coordinateProblem(doc) {
  const { anchor, seal, proof } = doc;
  if (!anchor || !seal || !proof || !Array.isArray(proof.siblingHashes)) return "the file lacks anchor, seal or proof";
  if (anchor.repo !== ANCHORS_REPO) return `the file names repository ${anchor.repo}, not ${ANCHORS_REPO}`;
  if (!/^[0-9a-f]{40}$/.test(String(anchor.commitSha))) return "the commit is not a 40-character hex SHA";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(seal.dateKey))) return "the seal date is malformed";
  if (anchor.filePath !== `daily-seals/${seal.dateKey}.json`) return `the file path ${anchor.filePath} is not daily-seals/${seal.dateKey}.json`;
  return null;
}

async function get(f, url, headers) {
  const res = await f(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

export async function main(path, { fetch: f = globalThis.fetch, log = console.log } = {}) {
  let doc, published;
  try {
    doc = JSON.parse(await readFile(path, "utf8"));
    if (doc.format !== "luu-sealed-record-proof/1") throw new Error("unknown format");
  } catch (e) {
    log(`cannot read ${path}: ${e.message}`);
    return 2;
  }
  const problem = coordinateProblem(doc);
  if (problem) {
    log(`RESULT: not checked. ${problem}.`);
    return 1;
  }
  const { hashedContent, contentHash, proof, seal, anchor } = doc;
  const recipe = recipeOf(hashedContent);
  const bytes = recipe === "jcs_v1" ? canonicalizeJcs(hashedContent) : canonicalizeV1Forecast(hashedContent);
  log(`1 canonical bytes (${recipe}): ${Buffer.byteLength(bytes, "utf8")}`);
  const leaf = sha256Hex(bytes);
  log(`2 sha256 ${short(leaf)} matches proof leaf: ${yes(leaf === contentHash)}`);
  const root = fold(leaf, proof.siblingHashes);
  log(`3 folded root ${short(root)} (${proof.siblingHashes.length} steps)`);
  const url = `https://raw.githubusercontent.com/${ANCHORS_REPO}/${anchor.commitSha}/${anchor.filePath}`;
  try {
    published = await get(f, url);
  } catch (e) {
    log(`4 could not fetch ${url}: ${e.message}`);
    return 2;
  }
  const rootOk = root === published.rootHash && published.rootHash === seal.rootHash && published.dateKey === seal.dateKey;
  log(`4 published root at ${anchor.commitSha.slice(0, 8)} ${anchor.filePath}: ${short(String(published.rootHash))} match: ${yes(rootOk)}`);
  const depth = published.summary?.treeDepth;
  const shapeOk = proof.siblingHashes.length === depth - 1 && published.leafCount === seal.leafCount;
  log(`5 proof length ${proof.siblingHashes.length} = treeDepth ${depth} - 1: ${yes(shapeOk)}`);
  if (!(leaf === contentHash && rootOk && shapeOk)) {
    log("RESULT: not included. The record as given does not reach the published root.");
    return 1;
  }
  // GitHub serves a fork's commit under the parent's raw URL, so the commit
  // must also be on the anchors repository's own main branch.
  const compare = `https://api.github.com/repos/${ANCHORS_REPO}/compare/${anchor.commitSha}...${ANCHORS_BRANCH}`;
  let status;
  try {
    status = (await get(f, compare, { accept: "application/vnd.github+json" })).status;
  } catch (e) {
    log(`branch: could not ask GitHub whether ${anchor.commitSha.slice(0, 8)} is on ${ANCHORS_BRANCH}: ${e.message}`);
    log("RESULT: not confirmed. Steps 1 to 5 match, but the commit could not be placed on the anchors repository's main branch. Try again later.");
    return 2;
  }
  const onMain = status === "ahead" || status === "identical";
  log(`branch: commit ${anchor.commitSha.slice(0, 8)} is on ${ANCHORS_REPO} ${ANCHORS_BRANCH}: ${yes(onMain)}`);
  if (!onMain) {
    log("RESULT: not included. The commit is not on the anchors repository's main branch.");
    return 1;
  }
  log(`RESULT: included. The record existed no later than GitHub's push time for this commit: https://github.com/${ANCHORS_REPO}/activity`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode rather than exit(), so open sockets close before the process ends
  if (!process.argv[2]) console.log("usage: node verify-inclusion.mjs record-and-proof.json");
  process.exitCode = process.argv[2] ? await main(process.argv[2]) : 2;
}
