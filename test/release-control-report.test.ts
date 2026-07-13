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
import {
  parseReleaseContract,
  parseReleasePullMetadata,
} from "../dist/release-control/contract.js";

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

test("cannot clear a contract with duplicate authoritative headings", () => {
  const parsed = parseReleaseContract(`
## Release train
2026.7.1
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
- changelog-only
## Exit criteria
Checks pass.
## Approved exceptions
None.
`);
  const input = structuredClone(historicalFixture);
  input.collectionComplete = parsed.value !== null;

  const report = buildReleaseReport(input);
  assert.equal(parsed.value, null);
  assert.deepEqual(parsed.missingFields, ["Release train"]);
  assert.equal(report.status, "incomplete");
});

test("cannot allow a change with conflicting duplicate release-class metadata", () => {
  const parsed = parseReleasePullMetadata(`
Release train: #900
Release class: release-blocker
Release class: changelog-only
Blocker: #901
Source on main: not applicable
Exception decision: not required
`);
  const input = structuredClone(historicalFixture);
  input.changes = [
    {
      sha: "d".repeat(40),
      prNumber: 106,
      title: "docs: release note",
      paths: ["CHANGELOG.md"],
      pathsComplete: true,
      collectionComplete: parsed.value !== null,
      metadataMissingFields: parsed.missingFields,
    },
  ];

  const report = buildReleaseReport(input);
  assert.equal(parsed.value, null);
  assert.deepEqual(parsed.missingFields, ["Release class"]);
  assert.equal(report.status, "incomplete");
  assert.notEqual(report.changes[0]?.status, "allowed");
});

test("cannot allow or clear changelog-only metadata with blank proof fields", () => {
  for (const blankField of ["Blocker", "Source on main", "Exception decision"] as const) {
    const values = {
      Blocker: "not applicable",
      "Source on main": "not applicable",
      "Exception decision": "not required",
    };
    values[blankField] = "   ";
    const parsed = parseReleasePullMetadata(`
Release train: #900
Release class: changelog-only
Blocker: ${values.Blocker}
Source on main: ${values["Source on main"]}
Exception decision: ${values["Exception decision"]}
`);
    const input = structuredClone(historicalFixture);
    input.changes = [
      {
        sha: "e".repeat(40),
        prNumber: 107,
        title: "docs: release note",
        paths: ["CHANGELOG.md"],
        pathsComplete: true,
        collectionComplete: parsed.value !== null,
        ...(parsed.value
          ? { metadata: parsed.value }
          : { metadataMissingFields: parsed.missingFields }),
      },
    ];

    const report = buildReleaseReport(input);
    assert.equal(parsed.value, null, blankField);
    assert.deepEqual(parsed.missingFields, [blankField], blankField);
    assert.equal(report.status, "incomplete", blankField);
    assert.notEqual(report.changes[0]?.status, "allowed", blankField);
  }
});
