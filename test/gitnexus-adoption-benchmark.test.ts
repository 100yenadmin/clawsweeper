import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("GitNexus adoption benchmark emits normalized savings metrics", () => {
  const output = execFileSync(process.execPath, [
    "scripts/gitnexus-adoption-benchmark.mjs",
    "--",
    "--scenario",
    "auth-session-seeded",
    "--baseline-tokens",
    "100000",
    "--gitnexus-tokens",
    "60000",
    "--baseline-runtime-ms",
    "120000",
    "--gitnexus-runtime-ms",
    "90000",
    "--baseline-tool-calls",
    "30",
    "--gitnexus-tool-calls",
    "18",
    "--seeded-findings-caught",
    "3",
    "--seeded-findings-total",
    "3",
    "--false-positive-count",
    "0",
    "--graph-freshness",
    "fresh",
  ]).toString();

  const result = JSON.parse(output);
  assert.equal(result.evalName, "clawsweeper-gitnexus-adoption-v0.1");
  assert.equal(result.scenario, "auth-session-seeded");
  assert.equal(result.tokenDeltaPercent, 40);
  assert.equal(result.runtimeDeltaPercent, 25);
  assert.equal(result.toolCallDelta, 12);
  assert.equal(result.seededFindingsCaught, 3);
  assert.equal(result.seededFindingsTotal, 3);
  assert.equal(result.falsePositiveCount, 0);
  assert.equal(result.graphFreshness, "fresh");
  assert.equal(result.secretLeakageDetected, false);
});
