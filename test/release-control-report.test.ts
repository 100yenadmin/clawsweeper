import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReleaseReport,
  renderReleaseReportJson,
  renderReleaseReportMarkdown,
  type ReleaseReportInput,
} from "../dist/release-control/report.js";
import { parseReleaseContract } from "../dist/release-control/contract.js";

const historicalFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("fixtures/release-control-2026.7.1.json", import.meta.url)),
    "utf8",
  ),
) as ReleaseReportInput;

test("renders stable deterministic JSON and Markdown for unchanged inputs", () => {
  const first = buildReleaseReport(historicalFixture);
  const second = buildReleaseReport(structuredClone(historicalFixture));

  assert.equal(renderReleaseReportJson(first), renderReleaseReportJson(second));
  assert.equal(renderReleaseReportMarkdown(first), renderReleaseReportMarkdown(second));
  assert.equal(first.schema_version, 1);
  assert.equal(first.status, "incomplete");
  assert.deepEqual(first.counts, {
    allowed: 0,
    candidate_resets: 0,
    commits: 2,
    pending_exceptions: 0,
    product_change_signals: 4,
    prs: 2,
    unclassified: 0,
  });
  assert.deepEqual(
    first.changes.map((change) => change.title),
    [
      "feat: support GPT-5.6 Ultra across OpenClaw and Codex runtimes (#98021)",
      "feat(providers): add Meta Model API - muse-spark-1.1 (#102873)",
    ],
  );
  assert.ok(first.changes.every((change) => change.signals.includes("feature-title")));
  assert.match(renderReleaseReportMarkdown(first), /Meta Model API/);
  assert.match(renderReleaseReportMarkdown(first), /GPT-5\.6 Ultra/);
});

test("applies report status precedence incomplete over blocked over attention over clear", () => {
  const base = structuredClone(historicalFixture);
  base.changes = [];
  assert.equal(buildReleaseReport(base).status, "clear");

  base.changes = [
    {
      sha: "d".repeat(40),
      title: "docs: unclassified release note",
      paths: ["docs/note.md"],
      pathsComplete: true,
    },
  ];
  assert.equal(buildReleaseReport(base).status, "attention");

  base.changes = [
    {
      sha: "e".repeat(40),
      prNumber: 990,
      title: "docs: invalid changelog-only declaration",
      paths: ["docs/note.md"],
      pathsComplete: true,
      metadata: {
        contractIssue: 900,
        releaseClass: "changelog-only",
      },
    },
  ];
  assert.equal(buildReleaseReport(base).status, "blocked");

  base.collectionComplete = false;
  assert.equal(buildReleaseReport(base).status, "incomplete");
});

test("cannot allow or clear a negated approved-exception contract line", () => {
  const decisionUrl = "https://github.com/openclaw/openclaw/issues/900#issuecomment-106";
  const parsed = parseReleaseContract(`
## Release train
2026.7.1
## Release captain
@alice
## Goal
Ship a narrow beta.
## Non-goals
No product work.
## Cut SHA
1111111111111111111111111111111111111111
## Allowed change classes
- exception
## Exit criteria
Checks pass.
## Approved exceptions
#106: not approved by @alice (${decisionUrl})
`);
  const input = structuredClone(historicalFixture);
  input.collectionComplete = parsed.value !== null;
  input.contract.approvedExceptions = parsed.value?.approvedExceptions ?? [];
  input.changes = [
    {
      sha: "c".repeat(40),
      prNumber: 106,
      title: "docs: exception candidate",
      paths: ["docs/release-note.md"],
      pathsComplete: true,
      metadata: {
        contractIssue: input.contractIssue.number,
        releaseClass: "exception",
        exceptionDecisionUrl: decisionUrl,
      },
    },
  ];

  const report = buildReleaseReport(input);
  assert.equal(parsed.value, null);
  assert.equal(report.status, "incomplete");
  assert.notEqual(report.changes[0]?.status, "allowed");
});
