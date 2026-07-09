import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitNexusContextPacket,
  renderGitNexusContextPacketForPrompt,
  type GitNexusCommandResult,
} from "../dist/gitnexus-context.js";

function runnerFor(outputs: Record<string, GitNexusCommandResult>) {
  return (command: string, args: readonly string[]): GitNexusCommandResult => {
    const key = [command, ...args].join(" ");
    return outputs[key] ?? { status: 1, stdout: "", stderr: `unexpected command: ${key}` };
  };
}

test("GitNexus context packet includes fresh related context and stable metadata", () => {
  const packet = buildGitNexusContextPacket({
    enabled: true,
    repo: "openclaw/openclaw",
    repoPath: "/repo/openclaw",
    pullRequestNumber: 42,
    baseSha: "base1234567890",
    headSha: "abc1234567890",
    changedFiles: [{ path: "src/runtime/auth/session-store.ts", additions: 10, deletions: 2 }],
    repoAliases: { "openclaw/openclaw": "openclaw" },
    now: () => "2026-07-09T00:00:00.000Z",
    runner: runnerFor({
      "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
      "gitnexus list": {
        status: 0,
        stdout: [
          "  openclaw",
          "    Path:    /repo/openclaw",
          "    Indexed: 7/9/2026, 1:00:00 AM",
          "    Commit:  abc1234",
        ].join("\n"),
        stderr: "",
      },
      "gitnexus query src/runtime/auth/session-store.ts --repo openclaw --limit 3 --max-tokens 800":
        {
          status: 0,
          stdout: "Runtime session auth flow references token refresh and session persistence.",
          stderr: "",
        },
    }),
  });

  assert.equal(packet.gitnexus.freshness, "fresh");
  assert.equal(packet.relatedContext.length, 1);
  assert.equal(packet.relatedContext[0]?.query, "src/runtime/auth/session-store.ts");
  assert.match(
    renderGitNexusContextPacketForPrompt(packet),
    /current PR diff remains authoritative/,
  );
  assert.match(packet.sha256, /^[a-f0-9]{64}$/);
  assert.match(packet.contentSha256, /^[a-f0-9]{64}$/);
});

test("GitNexus content digest is stable across packet generation timestamps", () => {
  const buildPacket = (generatedAt: string) =>
    buildGitNexusContextPacket({
      enabled: true,
      repo: "openclaw/openclaw",
      repoPath: "/repo/openclaw",
      pullRequestNumber: 42,
      baseSha: "base1234567890",
      headSha: "abc1234567890",
      changedFiles: [{ path: "src/runtime/auth/session-store.ts", additions: 10, deletions: 2 }],
      repoAliases: { "openclaw/openclaw": "openclaw" },
      now: () => generatedAt,
      runner: runnerFor({
        "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
        "gitnexus list": {
          status: 0,
          stdout: [
            "  openclaw",
            "    Path:    /repo/openclaw",
            "    Indexed: 7/9/2026, 1:00:00 AM",
            "    Commit:  abc1234",
          ].join("\n"),
          stderr: "",
        },
        "gitnexus query src/runtime/auth/session-store.ts --repo openclaw --limit 3 --max-tokens 800":
          {
            status: 0,
            stdout: "Runtime session auth flow references token refresh and session persistence.",
            stderr: "",
          },
      }),
    });
  const first = buildPacket("2026-07-09T00:00:00.000Z");
  const second = buildPacket("2026-07-09T00:05:00.000Z");

  assert.notEqual(first.sha256, second.sha256);
  assert.equal(first.contentSha256, second.contentSha256);
});

test("GitNexus context packet degrades when the index is stale and stale context is disabled", () => {
  const packet = buildGitNexusContextPacket({
    enabled: true,
    repo: "openclaw/openclaw",
    repoPath: "/repo/openclaw",
    pullRequestNumber: 42,
    headSha: "abc1234567890",
    changedFiles: [{ path: "src/runtime/session.ts" }],
    repoAliases: { "openclaw/openclaw": "openclaw" },
    runner: runnerFor({
      "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
      "gitnexus list": {
        status: 0,
        stdout: ["  openclaw", "    Path:    /repo/openclaw", "    Commit:  def9999"].join("\n"),
        stderr: "",
      },
    }),
  });

  assert.equal(packet.gitnexus.freshness, "stale");
  assert.equal(packet.relatedContext.length, 0);
  assert.match(packet.gitnexus.degradedReason ?? "", /stale/i);
});

test("GitNexus context packet fails closed on secret-like query output", () => {
  assert.throws(
    () =>
      buildGitNexusContextPacket({
        enabled: true,
        repo: "openclaw/openclaw",
        repoPath: "/repo/openclaw",
        pullRequestNumber: 42,
        headSha: "abc1234567890",
        changedFiles: [{ path: "src/runtime/auth.ts" }],
        repoAliases: { "openclaw/openclaw": "openclaw" },
        runner: runnerFor({
          "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
          "gitnexus list": {
            status: 0,
            stdout: ["  openclaw", "    Path:    /repo/openclaw", "    Commit:  abc1234"].join(
              "\n",
            ),
            stderr: "",
          },
          "gitnexus query src/runtime/auth.ts --repo openclaw --limit 3 --max-tokens 800": {
            status: 0,
            stdout: "OPENAI_API_KEY=sk-1234567890abcdef1234567890abcdef",
            stderr: "",
          },
        }),
      }),
    /secret-like GitNexus output/i,
  );
});

test("GitNexus context packet omits raw list failure output from prompt fields", () => {
  const packet = buildGitNexusContextPacket({
    enabled: true,
    repo: "openclaw/openclaw",
    repoPath: "/repo/openclaw",
    pullRequestNumber: 42,
    headSha: "abc1234567890",
    changedFiles: [{ path: "src/runtime/auth.ts" }],
    repoAliases: { "openclaw/openclaw": "openclaw" },
    runner: runnerFor({
      "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
      "gitnexus list": {
        status: 2,
        stdout: "raw stdout should not be prompted",
        stderr: "raw stderr should not be prompted",
      },
    }),
  });
  const rendered = renderGitNexusContextPacketForPrompt(packet);

  assert.equal(packet.gitnexus.freshness, "unknown");
  assert.match(packet.gitnexus.degradedReason ?? "", /command output omitted sha256=/);
  assert.doesNotMatch(rendered, /raw stdout should not be prompted/);
  assert.doesNotMatch(rendered, /raw stderr should not be prompted/);
});

test("GitNexus context packet omits raw query failure output from prompt fields", () => {
  const packet = buildGitNexusContextPacket({
    enabled: true,
    repo: "openclaw/openclaw",
    repoPath: "/repo/openclaw",
    pullRequestNumber: 42,
    headSha: "abc1234567890",
    changedFiles: [{ path: "src/runtime/auth.ts" }],
    repoAliases: { "openclaw/openclaw": "openclaw" },
    runner: runnerFor({
      "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
      "gitnexus list": {
        status: 0,
        stdout: ["  openclaw", "    Path:    /repo/openclaw", "    Commit:  abc1234"].join("\n"),
        stderr: "",
      },
      "gitnexus query src/runtime/auth.ts --repo openclaw --limit 3 --max-tokens 800": {
        status: 1,
        stdout: "raw query stdout should not be prompted",
        stderr: "raw query stderr should not be prompted",
      },
    }),
  });
  const rendered = renderGitNexusContextPacketForPrompt(packet);

  assert.equal(packet.relatedContext.length, 0);
  assert.match(packet.omittedContext.join("\n"), /command output omitted sha256=/);
  assert.doesNotMatch(rendered, /raw query stdout should not be prompted/);
  assert.doesNotMatch(rendered, /raw query stderr should not be prompted/);
});

test("GitNexus context packet fails closed on secret-like failure output", () => {
  assert.throws(
    () =>
      buildGitNexusContextPacket({
        enabled: true,
        repo: "openclaw/openclaw",
        repoPath: "/repo/openclaw",
        pullRequestNumber: 42,
        headSha: "abc1234567890",
        changedFiles: [{ path: "src/runtime/auth.ts" }],
        repoAliases: { "openclaw/openclaw": "openclaw" },
        runner: runnerFor({
          "git rev-parse HEAD": { status: 0, stdout: "abc1234567890\n", stderr: "" },
          "gitnexus list": {
            status: 0,
            stdout: ["  openclaw", "    Path:    /repo/openclaw", "    Commit:  abc1234"].join(
              "\n",
            ),
            stderr: "",
          },
          "gitnexus query src/runtime/auth.ts --repo openclaw --limit 3 --max-tokens 800": {
            status: 1,
            stdout: "",
            stderr: "GITHUB_TOKEN=ghp_abcdefghijklmnop",
          },
        }),
      }),
    /secret-like GitNexus failure output/i,
  );
});
