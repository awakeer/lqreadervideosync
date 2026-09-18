import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(rootDir, "dist", "tests");
const mediaTests = new Set(["validate-mkv-probe.mjs", "validate-mp4-probe.mjs"]);
const tests = readdirSync(testsDir)
  .filter((name) => name.startsWith("validate-") && name.endsWith(".mjs") && !mediaTests.has(name))
  .sort();

for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const result = spawnSync(process.execPath, [path.join(testsDir, test)], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\n${tests.length} community regression tests passed.`);
