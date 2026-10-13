// Compares the pinned snapshot of OBL's src/js/donations.js with OBL's current file on the rock
// branch, and with --update, replaces the snapshot. The tests then say whether this
// repository's copy of the contract still matches. Needs the network; the tests don't.
//
//   node scripts/obl-contract.mjs [--update]

import { readFileSync, writeFileSync } from "node:fs";

const fixture = new URL("../tests/fixtures/obl-donations.js", import.meta.url);
const sourceFile = new URL("../tests/fixtures/obl-donations.source.json", import.meta.url);
const source = JSON.parse(readFileSync(sourceFile, "utf8"));
const api = `https://api.github.com/repos/${source.repository}`;

const commits = await (await fetch(`${api}/commits?sha=rock&path=${source.path}&per_page=1`)).json();
const latest = commits[0]?.sha;
if (!latest) throw new Error("couldn't find OBL's latest commit for the file");
if (latest === source.commit) {
  console.log(`The snapshot is current: ${source.path} at ${latest}.`);
  process.exit(0);
}

const raw = `https://raw.githubusercontent.com/${source.repository}/${latest}/${source.path}`;
const text = await (await fetch(raw)).text();
const changed = text !== readFileSync(fixture, "utf8");
console.log(`OBL changed ${source.path} in ${latest}; the file itself ${changed ? "differs" : "is the same"}.`);
if (process.argv.includes("--update")) {
  writeFileSync(fixture, text);
  writeFileSync(sourceFile, `${JSON.stringify({ ...source, commit: latest }, null, 2)}\n`);
  console.log("Snapshot updated. Run node --test to see whether the contract still matches.");
} else if (changed) {
  process.exitCode = 1;
}
