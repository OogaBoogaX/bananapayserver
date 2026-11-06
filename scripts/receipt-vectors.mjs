// Writes tests/fixtures/receipt-accounting-v1.json from the real core emitters. Run it only
// after a reviewed change to the contract, then review the diff: pages consume these exact
// bytes, and tests/receipt-contract.test.mjs fails until the file matches.
//
//   node scripts/receipt-vectors.mjs

import { writeFileSync } from "node:fs";
import { buildVectors, FIXTURE, serialize } from "../tests/helpers/receipt-vectors.mjs";

writeFileSync(FIXTURE, serialize(await buildVectors()));
console.log("wrote tests/fixtures/receipt-accounting-v1.json");
