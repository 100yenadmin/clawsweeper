import assert from "node:assert/strict";
import test from "node:test";

import { classifyReleaseChange } from "../dist/release-control/classifier.js";
import type { ReleaseContract, ReleasePullMetadata } from "../dist/release-control/contract.js";

const contract: ReleaseContract = {
  train: "2026.7.2",
  captain: "alice",
  goal: "Ship a narrow beta.",
  nonGoals: "No unrelated product changes.",
  cutSha: "0123456789abcdef0123456789abcdef01234567",
  allowedChangeClasses: [
    "release-preparation",
    "release-blocker",
    "exact-backport",
    "release-infrastructure",
    "changelog-only",
    "exception",
  ],
  exitCriteria: "Release checks pass.",
  approvedExceptions: [
    {
      number: 106,
      decision: "approved",
      approver: "alice",
      decisionUrl: "https://github.com/openclaw/openclaw/issues/900#issuecomment-106",
    },
  ],
};

const policy = {
  releasePreparation: {
    exactPaths: ["package.json", "pnpm-lock.yaml"],
    prefixes: ["apps/macos/Sources/OpenClaw/Resources/"],
  },
  releaseInfrastructure: {
    exactPaths: [".agents/skills/release-openclaw-maintainer/SKILL.md"],
    prefixes: [".github/workflows/release-", "scripts/release", "docs/reference/RELEASING"],
  },
};

function metadata(
  releaseClass: ReleasePullMetadata["releaseClass"],
  extra: Partial<ReleasePullMetadata> = {},
): ReleasePullMetadata {
  return { contractIssue: 900, releaseClass, ...extra };
}

test("allows each declared release class only with its required deterministic proof", () => {
  const cases = [
    {
      name: "release preparation",
      prNumber: 101,
      paths: ["package.json", "pnpm-lock.yaml"],
      metadata: metadata("release-preparation"),
    },
    {
      name: "release blocker",
      prNumber: 102,
      paths: ["src/daemon.ts"],
      metadata: metadata("release-blocker", { blockerIssue: 800 }),
    },
    {
      name: "exact backport",
      prNumber: 103,
      paths: ["src/daemon.ts"],
      metadata: metadata("exact-backport", {
        sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
        sourcePull: 700,
      }),
      sourceMainReachable: true,
      patchEquivalent: true,
    },
    {
      name: "release infrastructure",
      prNumber: 104,
      paths: [".github/workflows/release-publish.yml"],
      metadata: metadata("release-infrastructure"),
    },
    {
      name: "changelog only",
      prNumber: 105,
      paths: ["CHANGELOG.md"],
      metadata: metadata("changelog-only"),
    },
    {
      name: "approved exception",
      prNumber: 106,
      paths: ["src/new-api.ts"],
      metadata: metadata("exception", {
        exceptionDecisionUrl: "https://github.com/openclaw/openclaw/issues/900#issuecomment-106",
      }),
    },
  ] as const;

  for (const scenario of cases) {
    const result = classifyReleaseChange({
      sha: "a".repeat(40),
      title: scenario.name,
      contractIssue: 900,
      contract,
      policy,
      ...scenario,
    });
    assert.equal(result.status, "allowed", scenario.name);
  }
});

test("fails closed for invalid class variants and incomplete evidence", () => {
  const base = {
    sha: "b".repeat(40),
    prNumber: 200,
    title: "release adjustment",
    paths: ["src/runtime.ts"],
    contractIssue: 900,
    contract,
    policy,
  };

  assert.equal(
    classifyReleaseChange({ ...base, metadata: metadata("release-preparation") }).status,
    "blocked",
  );
  assert.equal(
    classifyReleaseChange({ ...base, metadata: metadata("release-blocker") }).status,
    "incomplete",
  );
  assert.equal(
    classifyReleaseChange({
      ...base,
      metadata: metadata("exact-backport", {
        sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
        sourcePull: 700,
      }),
    }).status,
    "incomplete",
  );
  assert.equal(
    classifyReleaseChange({
      ...base,
      metadata: metadata("exact-backport", {
        sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
        sourcePull: 700,
      }),
      sourceMainReachable: false,
      patchEquivalent: true,
    }).status,
    "blocked",
  );
  assert.equal(
    classifyReleaseChange({
      ...base,
      metadata: metadata("exact-backport", {
        sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
        sourcePull: 700,
      }),
      sourceMainReachable: true,
      patchEquivalent: false,
    }).status,
    "blocked",
  );
  assert.equal(
    classifyReleaseChange({ ...base, metadata: metadata("release-infrastructure") }).status,
    "blocked",
  );
  assert.equal(
    classifyReleaseChange({
      ...base,
      paths: ["CHANGELOG.md", "src/runtime.ts"],
      metadata: metadata("changelog-only"),
    }).status,
    "blocked",
  );
  assert.equal(
    classifyReleaseChange({ ...base, prNumber: undefined, metadata: undefined }).status,
    "unclassified",
  );
  assert.equal(
    classifyReleaseChange({ ...base, metadataMissingFields: ["Release class"] }).status,
    "incomplete",
  );

  const incompletePaths = {
    ...base,
    paths: ["CHANGELOG.md"],
    pathsComplete: false,
    metadata: metadata("changelog-only"),
  };
  assert.equal(classifyReleaseChange(incompletePaths).status, "incomplete");
});

test("requires exception listing, captain approval, and a matching decision link", () => {
  const base = {
    sha: "c".repeat(40),
    title: "exception candidate",
    paths: ["src/runtime.ts"],
    contractIssue: 900,
    policy,
  };
  const pendingContract = {
    ...contract,
    approvedExceptions: [{ number: 201, decision: "pending" as const }],
  };
  assert.equal(
    classifyReleaseChange({
      ...base,
      prNumber: 201,
      contract: pendingContract,
      metadata: metadata("exception"),
    }).status,
    "incomplete",
  );
  const pendingDecisionUrl = "https://github.com/openclaw/openclaw/issues/900#issuecomment-201";
  assert.equal(
    classifyReleaseChange({
      ...base,
      prNumber: 201,
      contract: {
        ...pendingContract,
        approvedExceptions: [
          {
            number: 201,
            decision: "pending" as const,
            decisionUrl: pendingDecisionUrl,
          },
        ],
      },
      metadata: metadata("exception", { exceptionDecisionUrl: pendingDecisionUrl }),
    }).status,
    "pending-exception",
  );

  const wrongApproverContract = {
    ...contract,
    approvedExceptions: [
      {
        number: 202,
        decision: "approved" as const,
        approver: "bob",
        decisionUrl: "https://github.com/openclaw/openclaw/issues/900#issuecomment-202",
      },
    ],
  };
  assert.equal(
    classifyReleaseChange({
      ...base,
      prNumber: 202,
      contract: wrongApproverContract,
      metadata: metadata("exception", {
        exceptionDecisionUrl: "https://github.com/openclaw/openclaw/issues/900#issuecomment-202",
      }),
    }).status,
    "blocked",
  );
  assert.equal(
    classifyReleaseChange({
      ...base,
      prNumber: 203,
      contract: {
        ...contract,
        approvedExceptions: [
          {
            number: 203,
            decision: "approved" as const,
            approver: "alice",
          },
        ],
      },
      metadata: metadata("exception", {
        exceptionDecisionUrl: "https://github.com/openclaw/openclaw/issues/900#issuecomment-203",
      }),
    }).status,
    "incomplete",
  );
});
