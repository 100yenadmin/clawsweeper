import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseReleaseControlArgs } from "../dist/release-control/cli.js";
import { main } from "../dist/clawsweeper.js";
import { mockGhBinEnv } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));

test("parses the release-control audit CLI contract", () => {
  assert.deepEqual(
    parseReleaseControlArgs([
      "release-control-audit",
      "--repo",
      "openclaw/openclaw",
      "--release-branch",
      "release/2026.7.2",
      "--contract-issue",
      "900",
      "--mode",
      "advisory",
      "--output",
      "/tmp/audit",
      "--target-checkout",
      "/tmp/openclaw",
    ]),
    {
      repo: "openclaw/openclaw",
      releaseBranch: "release/2026.7.2",
      train: "2026.7.2",
      contractIssue: 900,
      mode: "advisory",
      output: "/tmp/audit",
      targetCheckout: "/tmp/openclaw",
    },
  );
  assert.throws(
    () =>
      parseReleaseControlArgs([
        "release-control-audit",
        "--repo",
        "openclaw/openclaw",
        "--release-branch",
        "main",
        "--contract-issue",
        "0",
        "--mode",
        "write",
        "--output",
        "/tmp/audit",
      ]),
    /release\/YYYY\.M\.PATCH/,
  );
});

test("does not finalize or publish action-ledger state for the read-only audit", async () => {
  let flushCalls = 0;
  await assert.rejects(
    main(["release-control-audit"], {
      flushWorkflowActionEvents: async () => {
        flushCalls += 1;
        return ["unexpected-state-shard.jsonl"];
      },
    }),
    /--repo is required/,
  );
  assert.equal(flushCalls, 0);
});

test("writes idempotent local reports using GitHub reads only", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-release-control-"));
  const output = join(root, "output");
  const ghMock = join(root, "gh-mock.mjs");
  const ghLog = join(root, "gh-calls.jsonl");
  const cutSha = "1".repeat(40);
  const codeSha = "2".repeat(40);
  const releaseSha = "3".repeat(40);
  const headSha = "a".repeat(40);
  const contractBody = `
## Release train
2026.7.2
## Release captain
@alice
## Goal
Ship a narrow beta.
## Non-goals
No unrelated product changes.
## Cut SHA
${cutSha}
## Allowed change classes
- release-preparation
- release-blocker
- exact-backport
- release-infrastructure
- changelog-only
- exception
## Exit criteria
All checks pass.
## Approved exceptions
None.
`;
  const prBody = `
Release train: #900
Release class: release-preparation
Blocker: not applicable
Source on main: not applicable
Exception decision: not required
`;
  const firstPagePaths = Array.from(
    { length: 100 },
    (_, index) => `extensions/fixture-${String(index).padStart(3, "0")}/package.json`,
  );
  const releases = [
    {
      id: 2,
      tag_name: "v2026.7.3-beta.1",
      prerelease: true,
      draft: false,
      published_at: "2026-07-11T12:20:00Z",
      created_at: "2026-07-11T12:10:00Z",
      body: `- release SHA: \`${"9".repeat(40)}\``,
    },
    {
      id: 1,
      tag_name: "v2026.7.2-beta.1",
      prerelease: true,
      draft: false,
      published_at: "2026-07-10T12:20:00Z",
      created_at: "2026-07-10T12:10:00Z",
      body: `### Release verification\n\n- release SHA: \`${releaseSha}\``,
    },
  ];
  const responses = {
    "repos/openclaw/openclaw/issues/900": {
      number: 900,
      html_url: "https://github.com/openclaw/openclaw/issues/900",
      updated_at: "2026-07-10T12:00:00Z",
      body: contractBody,
    },
    "repos/openclaw/openclaw/git/ref/heads/release%2F2026.7.2": {
      object: { sha: headSha },
    },
    "repos/openclaw/openclaw/releases?per_page=100": releases,
    "repos/openclaw/openclaw/releases?per_page=100&page=1": releases,
    "repos/openclaw/openclaw/git/ref/tags/v2026.7.2-beta.1": {
      object: { type: "commit", sha: releaseSha },
    },
    [`repos/openclaw/openclaw/commits/${releaseSha}?per_page=100&page=1`]: {
      sha: releaseSha,
      parents: [{ sha: codeSha }],
      commit: {
        message: "docs(changelog): publish 2026.7.2 beta 1",
        committer: { date: "2026-07-10T12:15:00Z" },
      },
      files: [{ filename: "CHANGELOG.md" }],
    },
    [`repos/openclaw/openclaw/compare/${cutSha}...${headSha}`]: {
      status: "ahead",
      total_commits: 1,
      commits: [{ sha: headSha }],
      base_commit: { sha: cutSha },
      merge_base_commit: { sha: cutSha },
    },
    [`repos/openclaw/openclaw/compare/${cutSha}...${codeSha}`]: {
      status: "ahead",
      total_commits: 1,
      commits: [{ sha: codeSha }],
      base_commit: { sha: cutSha },
      merge_base_commit: { sha: cutSha },
    },
    [`repos/openclaw/openclaw/compare/${releaseSha}...${headSha}`]: {
      status: "ahead",
      total_commits: 1,
      commits: [{ sha: headSha }],
      base_commit: { sha: releaseSha },
      merge_base_commit: { sha: releaseSha },
    },
    [`repos/openclaw/openclaw/commits/${headSha}?per_page=100&page=1`]: {
      sha: headSha,
      commit: {
        message: "ci: update release infrastructure",
        committer: { date: "2026-07-10T12:10:00Z" },
      },
      files: firstPagePaths.map((filename) => ({ filename })),
    },
    [`repos/openclaw/openclaw/commits/${headSha}?per_page=100&page=2`]: {
      sha: headSha,
      files: [{ filename: "npm-shrinkwrap.json" }],
    },
  };

  try {
    writeFileSync(
      ghMock,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const responses = ${JSON.stringify(responses)};
if (args[0] === "api" && args[1] === "graphql") {
  const query = args.find((arg) => arg.startsWith("query=")) ?? "";
  if (query.includes("associatedPullRequests(first:100,states:")) {
    console.error("unsupported associatedPullRequests states argument");
    process.exit(2);
  }
  if (!query.includes("associatedPullRequests(first:100){nodes{number url body baseRefName}pageInfo{hasNextPage}}")) {
    console.error("unexpected associatedPullRequests query shape");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ data: { repository: { object: { associatedPullRequests: {
    nodes: [{ number: 901, url: "https://github.com/openclaw/openclaw/pull/901", body: ${JSON.stringify(prBody)}, baseRefName: "release/2026.7.2" }],
    pageInfo: { hasNextPage: false }
  } } } } }));
  process.exit(0);
}
if (args[0] !== "api" || !(args[1] in responses)) {
  console.error("unexpected gh args " + JSON.stringify(args));
  process.exit(2);
}
process.stdout.write(JSON.stringify(responses[args[1]]));
`,
    );
    const argv = [
      CLI,
      "release-control-audit",
      "--repo",
      "openclaw/openclaw",
      "--release-branch",
      "release/2026.7.2",
      "--contract-issue",
      "900",
      "--mode",
      "advisory",
      "--output",
      output,
    ];
    const env = { ...process.env, ...mockGhBinEnv(ghMock), GH_LOG: ghLog };
    const first = spawnSync(process.execPath, argv, { encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    const firstJson = readFileSync(join(output, "2026.7.2.json"), "utf8");
    const firstMarkdown = readFileSync(join(output, "2026.7.2.md"), "utf8");

    const second = spawnSync(process.execPath, argv, { encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(output, "2026.7.2.json"), "utf8"), firstJson);
    assert.equal(readFileSync(join(output, "2026.7.2.md"), "utf8"), firstMarkdown);
    assert.deepEqual(readdirSync(output).sort(), ["2026.7.2.json", "2026.7.2.md"]);
    assert.equal(JSON.parse(firstJson).status, "attention");
    assert.equal(JSON.parse(firstJson).changes[0].status, "allowed");
    assert.equal(JSON.parse(firstJson).code_sha, codeSha);
    assert.equal(JSON.parse(firstJson).release_sha, releaseSha);
    assert.equal(JSON.parse(firstJson).latest_beta, "v2026.7.2-beta.1");
    assert.equal(JSON.parse(firstJson).changes[0].paths.length, 101);

    const calls = readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((args) => args[0] === "api"));
    assert.ok(calls.every((args) => !args.includes("--method")));
    assert.ok(
      calls.some(
        (args) => args[1] === `repos/openclaw/openclaw/commits/${headSha}?per_page=100&page=2`,
      ),
    );
    assert.ok(calls.some((args) => args[1] === "graphql"));
    assert.ok(
      calls.every(
        (args) =>
          args[1] !== "graphql" ||
          args.some((arg) => arg.startsWith("query=query(") && !arg.includes("mutation")),
      ),
    );
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(
      packageJson.scripts["release-control:audit"],
      "node dist/clawsweeper.js release-control-audit",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const PROVENANCE_CUT_SHA = "4".repeat(40);
const PROVENANCE_RELEASE_SHA = "5".repeat(40);
const PROVENANCE_TAG_OBJECT_SHA = "6".repeat(40);
const PROVENANCE_OTHER_SHA = "7".repeat(40);
const PROVENANCE_TAG = "v2026.7.2-beta.9";

interface ReleaseAuditScenario {
  releasePages?: Record<number, unknown>;
  legacyReleases?: unknown;
  tagRef?: unknown;
  tagObjects?: Record<string, unknown>;
  compareOverrides?: Record<string, unknown>;
}

interface ReleaseAuditScenarioResult {
  report: { status: string; latest_beta: string | null };
  calls: string[][];
}

function betaRelease(id = 500): Record<string, unknown> {
  return {
    id,
    tag_name: PROVENANCE_TAG,
    prerelease: true,
    draft: false,
    published_at: "2026-07-10T12:20:00Z",
    created_at: "2026-07-10T12:10:00Z",
    body: `- Release SHA: \`${PROVENANCE_RELEASE_SHA}\``,
  };
}

function otherTrainReleases(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    tag_name: `v2026.8.0-beta.${index + 1}`,
    prerelease: true,
    draft: false,
    published_at: `2026-07-09T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    created_at: `2026-07-09T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    body: "",
  }));
}

function compareResponse(base: string, head: string): Record<string, unknown> {
  return base === head
    ? {
        status: "identical",
        total_commits: 0,
        commits: [],
        base_commit: { sha: base },
        merge_base_commit: { sha: base },
      }
    : {
        status: "ahead",
        total_commits: 1,
        commits: [{ sha: head }],
        base_commit: { sha: base },
        merge_base_commit: { sha: base },
      };
}

function runReleaseAuditScenario(scenario: ReleaseAuditScenario = {}): ReleaseAuditScenarioResult {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-release-provenance-"));
  const output = join(root, "output");
  const ghMock = join(root, "gh-mock.mjs");
  const ghLog = join(root, "gh-calls.jsonl");
  const contractBody = `
## Release train
2026.7.2
## Release captain
@alice
## Goal
Ship a narrow beta.
## Non-goals
No unrelated product changes.
## Cut SHA
${PROVENANCE_CUT_SHA}
## Allowed change classes
- changelog-only
## Exit criteria
All checks pass.
## Approved exceptions
None.
`;
  const prBody = `
Release train: #900
Release class: changelog-only
Blocker: not applicable
Source on main: not applicable
Exception decision: not required
`;
  const release = betaRelease();
  const responses: Record<string, unknown> = {
    "repos/openclaw/openclaw/issues/900": {
      number: 900,
      html_url: "https://github.com/openclaw/openclaw/issues/900",
      updated_at: "2026-07-10T12:00:00Z",
      body: contractBody,
    },
    "repos/openclaw/openclaw/git/ref/heads/release%2F2026.7.2": {
      object: { type: "commit", sha: PROVENANCE_RELEASE_SHA },
    },
    "repos/openclaw/openclaw/releases?per_page=100": scenario.legacyReleases ?? [release],
    "repos/openclaw/openclaw/git/ref/tags/v2026.7.2-beta.9": scenario.tagRef ?? {
      object: { type: "tag", sha: PROVENANCE_TAG_OBJECT_SHA },
    },
    [`repos/openclaw/openclaw/git/tags/${PROVENANCE_TAG_OBJECT_SHA}`]: {
      sha: PROVENANCE_TAG_OBJECT_SHA,
      object: { type: "commit", sha: PROVENANCE_RELEASE_SHA },
    },
    [`repos/openclaw/openclaw/commits/${PROVENANCE_RELEASE_SHA}?per_page=100&page=1`]: {
      sha: PROVENANCE_RELEASE_SHA,
      parents: [{ sha: PROVENANCE_CUT_SHA }],
      commit: {
        message: "docs(changelog): publish 2026.7.2 beta 9",
        committer: { date: "2026-07-10T12:15:00Z" },
      },
      files: [{ filename: "CHANGELOG.md" }],
    },
    [`repos/openclaw/openclaw/compare/${PROVENANCE_CUT_SHA}...${PROVENANCE_CUT_SHA}`]:
      compareResponse(PROVENANCE_CUT_SHA, PROVENANCE_CUT_SHA),
    [`repos/openclaw/openclaw/compare/${PROVENANCE_RELEASE_SHA}...${PROVENANCE_RELEASE_SHA}`]:
      compareResponse(PROVENANCE_RELEASE_SHA, PROVENANCE_RELEASE_SHA),
    [`repos/openclaw/openclaw/compare/${PROVENANCE_CUT_SHA}...${PROVENANCE_RELEASE_SHA}`]:
      compareResponse(PROVENANCE_CUT_SHA, PROVENANCE_RELEASE_SHA),
  };
  for (const [page, value] of Object.entries(scenario.releasePages ?? { 1: [release] })) {
    responses[`repos/openclaw/openclaw/releases?per_page=100&page=${page}`] = value;
  }
  Object.assign(responses, scenario.tagObjects, scenario.compareOverrides);

  try {
    writeFileSync(
      ghMock,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const responses = ${JSON.stringify(responses)};
if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(JSON.stringify({ data: { repository: { object: { associatedPullRequests: {
    nodes: [{ number: 901, url: "https://github.com/openclaw/openclaw/pull/901", body: ${JSON.stringify(prBody)}, baseRefName: "release/2026.7.2" }],
    pageInfo: { hasNextPage: false }
  } } } } }));
  process.exit(0);
}
if (args[0] !== "api" || !(args[1] in responses)) {
  console.error("unexpected gh args " + JSON.stringify(args));
  process.exit(2);
}
process.stdout.write(JSON.stringify(responses[args[1]]));
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "release-control-audit",
        "--repo",
        "openclaw/openclaw",
        "--release-branch",
        "release/2026.7.2",
        "--contract-issue",
        "900",
        "--mode",
        "advisory",
        "--output",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ...mockGhBinEnv(ghMock), GH_LOG: ghLog },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return {
      report: JSON.parse(readFileSync(join(output, "2026.7.2.json"), "utf8")) as {
        status: string;
        latest_beta: string | null;
      },
      calls: readFileSync(ghLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("verifies an annotated beta tag and proper release lineage", () => {
  const { report, calls } = runReleaseAuditScenario();
  assert.equal(report.status, "clear");
  assert.equal(report.latest_beta, PROVENANCE_TAG);
  for (const endpoint of [
    "repos/openclaw/openclaw/releases?per_page=100&page=1",
    `repos/openclaw/openclaw/git/ref/tags/${PROVENANCE_TAG}`,
    `repos/openclaw/openclaw/git/tags/${PROVENANCE_TAG_OBJECT_SHA}`,
    `repos/openclaw/openclaw/compare/${PROVENANCE_CUT_SHA}...${PROVENANCE_CUT_SHA}`,
    `repos/openclaw/openclaw/compare/${PROVENANCE_RELEASE_SHA}...${PROVENANCE_RELEASE_SHA}`,
  ]) {
    assert.ok(
      calls.some((args) => args[1] === endpoint),
      endpoint,
    );
  }
});

test("fails closed for a wrong beta tag, unrelated lineage, or tag-object SHA mismatch", () => {
  const invalidScenarios: Array<[string, ReleaseAuditScenario]> = [
    ["wrong tag", { tagRef: { object: { type: "commit", sha: PROVENANCE_OTHER_SHA } } }],
    [
      "unrelated lineage",
      {
        compareOverrides: {
          [`repos/openclaw/openclaw/compare/${PROVENANCE_CUT_SHA}...${PROVENANCE_CUT_SHA}`]: {
            status: "diverged",
            total_commits: 0,
            commits: [],
            base_commit: { sha: PROVENANCE_CUT_SHA },
            merge_base_commit: { sha: PROVENANCE_OTHER_SHA },
          },
        },
      },
    ],
    [
      "tag object mismatch",
      {
        tagObjects: {
          [`repos/openclaw/openclaw/git/tags/${PROVENANCE_TAG_OBJECT_SHA}`]: {
            sha: PROVENANCE_OTHER_SHA,
            object: { type: "commit", sha: PROVENANCE_RELEASE_SHA },
          },
        },
      },
    ],
    [
      "missing lineage response",
      {
        compareOverrides: {
          [`repos/openclaw/openclaw/compare/${PROVENANCE_CUT_SHA}...${PROVENANCE_CUT_SHA}`]: null,
        },
      },
    ],
    [
      "tag indirection cycle",
      {
        tagObjects: {
          [`repos/openclaw/openclaw/git/tags/${PROVENANCE_TAG_OBJECT_SHA}`]: {
            sha: PROVENANCE_TAG_OBJECT_SHA,
            object: { type: "tag", sha: PROVENANCE_TAG_OBJECT_SHA },
          },
        },
      },
    ],
  ];
  for (const [label, scenario] of invalidScenarios) {
    assert.equal(runReleaseAuditScenario(scenario).report.status, "incomplete", label);
  }
});

test("finds the named beta on the second complete release page", () => {
  const firstPage = otherTrainReleases(100);
  const { report, calls } = runReleaseAuditScenario({
    legacyReleases: firstPage,
    releasePages: { 1: firstPage, 2: [betaRelease()] },
  });
  assert.equal(report.status, "clear");
  assert.equal(report.latest_beta, PROVENANCE_TAG);
  assert.ok(
    calls.some((args) => args[1] === "repos/openclaw/openclaw/releases?per_page=100&page=2"),
  );
});

test("fails closed for missing release pages and duplicate release identities", () => {
  const fullPage = [betaRelease(), ...otherTrainReleases(99)];
  assert.equal(
    runReleaseAuditScenario({ releasePages: { 1: fullPage } }).report.status,
    "incomplete",
    "missing page 2",
  );
  assert.equal(
    runReleaseAuditScenario({
      releasePages: {
        1: [betaRelease(), { ...betaRelease(501), id: 501 }],
      },
    }).report.status,
    "incomplete",
    "duplicate tag identity",
  );
  assert.equal(
    runReleaseAuditScenario({
      releasePages: {
        1: [betaRelease(), { ...betaRelease(), tag_name: "v2026.8.0-beta.1" }],
      },
    }).report.status,
    "incomplete",
    "duplicate numeric identity",
  );
  assert.equal(
    runReleaseAuditScenario({ releasePages: { 1: { invalid: true } } }).report.status,
    "incomplete",
    "invalid page",
  );
});

test("fails closed for duplicate Release SHA declarations", () => {
  for (const [label, secondSha] of [
    ["duplicate same SHA", PROVENANCE_RELEASE_SHA],
    ["conflicting SHA", PROVENANCE_OTHER_SHA],
  ] as const) {
    const release = {
      ...betaRelease(),
      body: `- Release SHA: \`${PROVENANCE_RELEASE_SHA}\`\n- Release SHA: \`${secondSha}\``,
    };
    const report = runReleaseAuditScenario({
      legacyReleases: [release],
      releasePages: { 1: [release] },
    }).report;
    assert.equal(report.status, "incomplete", label);
  }
});
