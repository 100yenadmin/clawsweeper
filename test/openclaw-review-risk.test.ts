import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOpenClawDeepRegressionRisk,
  renderOpenClawDeepRegressionRiskForPrompt,
} from "../dist/openclaw-review-risk.js";

test("OpenClaw deep regression risk flags auth and session source changes as critical", () => {
  const packet = classifyOpenClawDeepRegressionRisk({
    repo: "openclaw/openclaw",
    itemKind: "pull_request",
    title: "Preserve auth session refresh",
    body: "Fixes token refresh in runtime sessions.",
    files: [
      { path: "src/runtime/auth/session-store.ts", additions: 40, deletions: 12 },
      { path: "src/runtime/auth/session-store.test.ts", additions: 30, deletions: 0 },
    ],
  });

  assert.equal(packet.riskLevel, "critical");
  assert.deepEqual(packet.surfaceCategories.slice().sort(), [
    "auth",
    "core",
    "runtime",
    "session_state",
  ]);
  assert.match(packet.reasons.join("\n"), /auth/i);
  assert.match(packet.requiredChecks.join("\n"), /maintainer/i);
});

test("OpenClaw deep regression risk demotes docs-only pull requests", () => {
  const packet = classifyOpenClawDeepRegressionRisk({
    repo: "openclaw/openclaw",
    itemKind: "pull_request",
    title: "Document gateway auth",
    body: "Docs only.",
    files: [{ path: "docs/gateway/auth.md", additions: 7, deletions: 1 }],
  });

  assert.equal(packet.riskLevel, "standard");
  assert.deepEqual(packet.surfaceCategories, ["docs_only"]);
  assert.match(renderOpenClawDeepRegressionRiskForPrompt(packet), /docs_only/);
});

test("OpenClaw deep regression risk marks release automation and config defaults high", () => {
  const packet = classifyOpenClawDeepRegressionRisk({
    repo: "openclaw/openclaw",
    itemKind: "pull_request",
    title: "Update release workflow defaults",
    body: "Changes default model provider during release.",
    files: [
      { path: ".github/workflows/release.yml", additions: 12, deletions: 3 },
      { path: "src/config/defaults.ts", additions: 6, deletions: 2 },
    ],
  });

  assert.equal(packet.riskLevel, "high");
  assert.deepEqual(packet.surfaceCategories.slice().sort(), [
    "config_defaults",
    "provider_routing",
    "release_automation",
  ]);
});
