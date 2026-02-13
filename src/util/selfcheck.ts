import fs from "fs";

function fail(msg: string) {
  console.error("SELF-CHECK FAILED:", msg);
  process.exit(1);
}

const required = [
  "accounts.json",
  "state/alts.json",
  "src/index.ts",
  "src/constants.ts"
];

for (const p of required) {
  if (!fs.existsSync(p)) fail(`Missing ${p}`);
}

console.log("Self-check OK.");
