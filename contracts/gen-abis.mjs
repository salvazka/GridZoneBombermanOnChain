// Extracts the ABIs from Foundry's build output into committed JS modules.
// `out/` is gitignored, so the server and client must not import from it
// directly or a fresh clone would fail before `forge build` has ever run.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const CONTRACTS = ["GridZoneArena", "MockUSDC"];

const TARGETS = [
  resolve(root, "../server/src/chain/abis.js"),
  resolve(root, "../client/src/lib/abis.js"),
];

const abis = {};
for (const name of CONTRACTS) {
  const artifactPath = resolve(root, `out/${name}.sol/${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  // Keep only what callers need; drop constructor/receive noise.
  abis[name] = artifact.abi.filter((f) => f.type === "function" || f.type === "event" || f.type === "error");
  console.log(`${name}: ${abis[name].length} ABI entries`);
}

const banner = `// GENERATED FILE - do not edit.
// Regenerate with: node contracts/gen-abis.mjs (after forge build)
`;

const body = Object.entries(abis)
  .map(([name, abi]) => `export const ${name.charAt(0).toLowerCase() + name.slice(1)}Abi = ${JSON.stringify(abi, null, 2)};\n`)
  .join("\n");

for (const target of TARGETS) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, banner + "\n" + body, "utf8");
  console.log(`written: ${target}`);
}
