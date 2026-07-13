import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exactBackportProof, verifyExactBackport } from "../dist/release-control/cli.js";
import { mockGhBinEnv } from "./helpers.ts";

interface BackportFixture {
  root: string;
  baseSha: string;
  sourceSha: string;
  releaseSha: string;
  mainSha: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, content: string, message: string): string {
  writeFileSync(join(cwd, "change.txt"), content, "utf8");
  git(cwd, ["add", "change.txt"]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function backportFixture(sourceOnMain: boolean): BackportFixture {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-release-backport-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.com"]);
  git(root, ["branch", "-M", "main"]);
  const baseSha = commit(root, "base\n", "base");
  if (!sourceOnMain) git(root, ["switch", "-c", "source"]);
  const sourceSha = commit(root, "backport payload\n", "source change");
  const mainSha = sourceOnMain ? sourceSha : baseSha;
  git(root, ["update-ref", "refs/remotes/origin/main", mainSha]);
  git(root, ["switch", "-c", "release", baseSha]);
  const releaseSha = commit(root, "backport payload\n", "release backport");
  return { root, baseSha, sourceSha, releaseSha, mainSha };
}

function withGhMock<T>(ghMock: string, callback: () => T): T {
  const previousBin = process.env.GH_BIN;
  const previousArgs = process.env.GH_BIN_ARGS;
  Object.assign(process.env, mockGhBinEnv(ghMock));
  try {
    return callback();
  } finally {
    if (previousBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = previousBin;
    if (previousArgs === undefined) delete process.env.GH_BIN_ARGS;
    else process.env.GH_BIN_ARGS = previousArgs;
  }
}

test("uses the read-only GitHub main ref for fresh exact-backport proof", () => {
  const fixture = backportFixture(true);
  const ghMock = join(fixture.root, "gh-mock.mjs");
  const ghLog = join(fixture.root, "gh-calls.jsonl");
  writeFileSync(
    ghMock,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
if (args.length !== 2 || args[0] !== "api" || args[1] !== "repos/openclaw/openclaw/git/ref/heads/main") process.exit(2);
process.stdout.write(JSON.stringify({ object: { sha: ${JSON.stringify(fixture.mainSha)} } }));
`,
    "utf8",
  );
  const previousLog = process.env.GH_LOG;
  process.env.GH_LOG = ghLog;
  try {
    assert.deepEqual(
      withGhMock(ghMock, () =>
        exactBackportProof(
          "openclaw/openclaw",
          fixture.root,
          fixture.sourceSha,
          fixture.releaseSha,
        ),
      ),
      { sourceMainReachable: true, patchEquivalent: true },
    );
    assert.deepEqual(JSON.parse(readFileSync(ghLog, "utf8").trim()), [
      "api",
      "repos/openclaw/openclaw/git/ref/heads/main",
    ]);
  } finally {
    if (previousLog === undefined) delete process.env.GH_LOG;
    else process.env.GH_LOG = previousLog;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("distinguishes a genuine source commit that is not on canonical main", () => {
  const fixture = backportFixture(false);
  try {
    assert.deepEqual(
      verifyExactBackport(fixture.root, fixture.sourceSha, fixture.releaseSha, fixture.mainSha),
      { sourceMainReachable: false, patchEquivalent: true },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("treats stale, missing, shallow, and operationally unavailable checkouts as incomplete", () => {
  const stale = backportFixture(true);
  const missing = backportFixture(true);
  const shallow = backportFixture(true);
  try {
    git(stale.root, ["update-ref", "refs/remotes/origin/main", stale.baseSha]);
    assert.deepEqual(
      verifyExactBackport(stale.root, stale.sourceSha, stale.releaseSha, stale.mainSha),
      {},
    );

    git(missing.root, ["update-ref", "-d", "refs/remotes/origin/main"]);
    assert.deepEqual(
      verifyExactBackport(missing.root, missing.sourceSha, missing.releaseSha, missing.mainSha),
      {},
    );
    assert.deepEqual(
      verifyExactBackport(missing.root, "f".repeat(40), missing.releaseSha, missing.mainSha),
      {},
    );

    writeFileSync(join(shallow.root, ".git", "shallow"), `${shallow.baseSha}\n`, "utf8");
    assert.deepEqual(
      verifyExactBackport(shallow.root, shallow.sourceSha, shallow.releaseSha, shallow.mainSha),
      {},
    );

    assert.deepEqual(
      verifyExactBackport(
        join(stale.root, "missing-checkout"),
        stale.sourceSha,
        stale.releaseSha,
        stale.mainSha,
      ),
      {},
    );
  } finally {
    rmSync(stale.root, { recursive: true, force: true });
    rmSync(missing.root, { recursive: true, force: true });
    rmSync(shallow.root, { recursive: true, force: true });
  }
});

test("treats a merge-base operational exit as incomplete rather than not-on-main", () => {
  const fixture = backportFixture(true);
  const gitMock = join(fixture.root, "git-mock.mjs");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    gitMock,
    `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "merge-base") process.exit(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 2);
`,
    "utf8",
  );
  const previousBin = process.env.GIT_BIN;
  const previousArgs = process.env.GIT_BIN_ARGS;
  process.env.GIT_BIN = process.execPath;
  process.env.GIT_BIN_ARGS = JSON.stringify([gitMock]);
  try {
    assert.deepEqual(
      verifyExactBackport(fixture.root, fixture.sourceSha, fixture.releaseSha, fixture.mainSha),
      {},
    );
  } finally {
    if (previousBin === undefined) delete process.env.GIT_BIN;
    else process.env.GIT_BIN = previousBin;
    if (previousArgs === undefined) delete process.env.GIT_BIN_ARGS;
    else process.env.GIT_BIN_ARGS = previousArgs;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
