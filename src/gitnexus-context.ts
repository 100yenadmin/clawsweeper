import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stableJson } from "./stable-json.js";

export type GitNexusFreshness = "fresh" | "stale" | "missing" | "unknown" | "not_applicable";

export interface GitNexusChangedFile {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface GitNexusCommandResult {
  status: number | null;
  stdout?: string | Buffer | undefined;
  stderr?: string | Buffer | undefined;
  error?: Error | undefined;
}

export type GitNexusCommandRunner = (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string | undefined;
    timeoutMs?: number | undefined;
    maxBuffer?: number | undefined;
  },
) => GitNexusCommandResult;

export interface GitNexusContextPacket {
  packetVersion: "gitnexus-context-packet-v0.1";
  repo: string;
  pullRequestNumber: number;
  baseSha: string | null;
  headSha: string | null;
  generatedAt: string;
  sha256: string;
  contentSha256: string;
  estimatedBytes: number;
  estimatedTokens: number;
  gitnexus: {
    alias: string | null;
    indexCommit: string | null;
    indexedAt: string | null;
    indexPath: string | null;
    freshness: GitNexusFreshness;
    degradedReason: string | null;
  };
  changedFiles: GitNexusChangedFile[];
  relatedContext: GitNexusRelatedContext[];
  omittedContext: string[];
  redaction: {
    status: "clean";
    sha256: string;
  };
}

export interface GitNexusRelatedContext {
  query: string;
  output: string;
}

export interface GitNexusContextPacketOptions {
  enabled: boolean;
  repo: string;
  repoPath: string;
  pullRequestNumber: number;
  baseSha?: string | null | undefined;
  headSha?: string | null | undefined;
  changedFiles: readonly GitNexusChangedFile[];
  repoAliases?: Record<string, string> | undefined;
  includeStaleContext?: boolean | undefined;
  maxPacketBytes?: number | undefined;
  maxRelatedItems?: number | undefined;
  queryLimit?: number | undefined;
  queryMaxTokens?: number | undefined;
  commandTimeoutMs?: number | undefined;
  maxCommandOutputBytes?: number | undefined;
  now?: () => string;
  runner?: GitNexusCommandRunner | undefined;
}

interface GitNexusListEntry {
  alias: string;
  path: string | null;
  indexedAt: string | null;
  commit: string | null;
}

const DEFAULT_MAX_PACKET_BYTES = 40_000;
const DEFAULT_MAX_RELATED_ITEMS = 8;
const DEFAULT_QUERY_LIMIT = 3;
const DEFAULT_QUERY_MAX_TOKENS = 800;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 8_000;

export function buildGitNexusContextPacket(
  options: GitNexusContextPacketOptions,
): GitNexusContextPacket {
  const now = options.now ?? (() => new Date().toISOString());
  const changedFiles = options.changedFiles.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const basePacket = packetShell(options, now(), changedFiles);
  if (!options.enabled) {
    return finalizePacket({
      ...basePacket,
      gitnexus: {
        ...basePacket.gitnexus,
        freshness: "not_applicable",
        degradedReason: "GitNexus context disabled.",
      },
    });
  }

  const runner = options.runner ?? defaultRunner;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCommandOutputBytes = options.maxCommandOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  const alias = resolveAlias(options.repo, options.repoAliases);
  if (!alias) {
    return finalizePacket({
      ...basePacket,
      gitnexus: {
        ...basePacket.gitnexus,
        freshness: "missing",
        degradedReason: `No GitNexus alias configured for ${options.repo}.`,
      },
    });
  }

  const currentHead = commandText(
    runner("git", ["rev-parse", "HEAD"], {
      cwd: options.repoPath,
      timeoutMs: commandTimeoutMs,
      maxBuffer: maxCommandOutputBytes,
    }),
  ).trim();
  const listResult = runner("gitnexus", ["list"], {
    timeoutMs: commandTimeoutMs,
    maxBuffer: maxCommandOutputBytes,
  });
  if (listResult.status !== 0) {
    return finalizePacket({
      ...basePacket,
      gitnexus: {
        alias,
        indexCommit: null,
        indexedAt: null,
        indexPath: null,
        freshness: "unknown",
        degradedReason: commandFailureDetail("gitnexus list", listResult),
      },
    });
  }

  const entry = parseGitNexusList(commandText(listResult)).find(
    (candidate) => candidate.alias === alias,
  );
  if (!entry) {
    return finalizePacket({
      ...basePacket,
      gitnexus: {
        alias,
        indexCommit: null,
        indexedAt: null,
        indexPath: null,
        freshness: "missing",
        degradedReason: `GitNexus alias ${alias} was not found.`,
      },
    });
  }

  const targetSha = options.headSha || currentHead || null;
  const freshness = indexFreshness(entry.commit, targetSha);
  const staleReason =
    freshness === "fresh"
      ? null
      : `GitNexus index is ${freshness}: commit ${entry.commit ?? "unknown"} does not match current head ${targetSha ?? "unknown"}.`;
  const packet: GitNexusContextPacket = {
    ...basePacket,
    gitnexus: {
      alias,
      indexCommit: entry.commit,
      indexedAt: entry.indexedAt,
      indexPath: entry.path,
      freshness,
      degradedReason: staleReason,
    },
  };

  if (freshness !== "fresh" && !options.includeStaleContext) return finalizePacket(packet);

  const maxRelatedItems = options.maxRelatedItems ?? DEFAULT_MAX_RELATED_ITEMS;
  const queryLimit = options.queryLimit ?? DEFAULT_QUERY_LIMIT;
  const queryMaxTokens = options.queryMaxTokens ?? DEFAULT_QUERY_MAX_TOKENS;
  for (const file of changedFiles.slice(0, maxRelatedItems)) {
    if (isGeneratedPath(file.path)) {
      packet.omittedContext.push(`${file.path}: generated or snapshot path`);
      continue;
    }
    const queryResult = runner(
      "gitnexus",
      [
        "query",
        file.path,
        "--repo",
        alias,
        "--limit",
        String(queryLimit),
        "--max-tokens",
        String(queryMaxTokens),
      ],
      { timeoutMs: commandTimeoutMs, maxBuffer: maxCommandOutputBytes },
    );
    if (queryResult.status !== 0) {
      packet.omittedContext.push(
        `${file.path}: ${commandFailureDetail("gitnexus query", queryResult)}`,
      );
      continue;
    }
    const output = truncateText(commandText(queryResult).trim(), maxCommandOutputBytes);
    if (!output) {
      packet.omittedContext.push(`${file.path}: empty GitNexus query output`);
      continue;
    }
    if (containsSecretLikeText(output)) {
      throw new Error(
        `Secret-like GitNexus output detected for ${file.path}; refusing to add graph context.`,
      );
    }
    packet.relatedContext.push({ query: file.path, output });
  }

  return trimToBudget(packet, options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES);
}

export function renderGitNexusContextPacketForPrompt(packet: GitNexusContextPacket): string {
  const related = packet.relatedContext.length
    ? packet.relatedContext.flatMap((entry) => [
        `### ${entry.query}`,
        "",
        "```text",
        entry.output,
        "```",
        "",
      ])
    : ["- none", ""];
  return [
    "## GitNexus Advisory Context",
    "",
    "This packet is advisory; the current PR diff remains authoritative.",
    `Packet SHA-256: ${packet.sha256}`,
    `Alias: ${packet.gitnexus.alias ?? "none"}`,
    `Freshness: ${packet.gitnexus.freshness}`,
    `Index commit: ${packet.gitnexus.indexCommit ?? "unknown"}`,
    `Degraded reason: ${packet.gitnexus.degradedReason ?? "none"}`,
    "",
    "Related context:",
    "",
    ...related,
    "Omitted context:",
    ...(packet.omittedContext.length
      ? packet.omittedContext.map((entry) => `- ${entry}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function packetShell(
  options: GitNexusContextPacketOptions,
  generatedAt: string,
  changedFiles: GitNexusChangedFile[],
): GitNexusContextPacket {
  return {
    packetVersion: "gitnexus-context-packet-v0.1",
    repo: options.repo,
    pullRequestNumber: options.pullRequestNumber,
    baseSha: options.baseSha ?? null,
    headSha: options.headSha ?? null,
    generatedAt,
    sha256: "",
    contentSha256: "",
    estimatedBytes: 0,
    estimatedTokens: 0,
    gitnexus: {
      alias: null,
      indexCommit: null,
      indexedAt: null,
      indexPath: null,
      freshness: "unknown",
      degradedReason: null,
    },
    changedFiles,
    relatedContext: [],
    omittedContext: [],
    redaction: {
      status: "clean",
      sha256: "",
    },
  };
}

function finalizePacket(packet: GitNexusContextPacket): GitNexusContextPacket {
  const withoutHashes = {
    ...packet,
    sha256: "",
    contentSha256: "",
    redaction: { ...packet.redaction, sha256: "" },
  };
  const redactionHash = sha256(stableJson(withoutHashes.relatedContext));
  const withRedaction = {
    ...withoutHashes,
    redaction: { status: "clean" as const, sha256: redactionHash },
  };
  const stableContent = { ...withRedaction, generatedAt: "" };
  const contentHash = sha256(stableJson(stableContent));
  const packetHash = sha256(stableJson(withRedaction));
  const finalPacket = { ...withRedaction, sha256: packetHash, contentSha256: contentHash };
  const estimatedBytes = Buffer.byteLength(stableJson(finalPacket), "utf8");
  return {
    ...finalPacket,
    estimatedBytes,
    estimatedTokens: Math.ceil(estimatedBytes / 4),
  };
}

function trimToBudget(
  packet: GitNexusContextPacket,
  maxPacketBytes: number,
): GitNexusContextPacket {
  let candidate = finalizePacket(packet);
  while (candidate.estimatedBytes > maxPacketBytes && candidate.relatedContext.length > 0) {
    const removed = candidate.relatedContext.pop();
    candidate.omittedContext.push(
      `${removed?.query ?? "unknown"}: omitted to fit packet byte budget`,
    );
    candidate = finalizePacket(candidate);
  }
  return candidate;
}

function resolveAlias(repo: string, aliases: Record<string, string> | undefined): string | null {
  const normalized = repo.trim().toLowerCase();
  return aliases?.[normalized] ?? (normalized === "openclaw/openclaw" ? "openclaw" : null);
}

function defaultRunner(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    timeoutMs?: number | undefined;
    maxBuffer?: number | undefined;
  } = {},
): GitNexusCommandResult {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });
}

function commandText(result: GitNexusCommandResult): string {
  return String(result.stdout ?? "");
}

function commandFailureDetail(command: string, result: GitNexusCommandResult): string {
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const error = result.error?.message ?? "";
  const output = [stderr, stdout, error].filter(Boolean).join("\n");
  if (containsSecretLikeText(output)) {
    throw new Error(
      `Secret-like GitNexus failure output detected for ${command}; refusing to add graph context.`,
    );
  }
  const status = result.status === null ? "unknown" : String(result.status);
  if (!output) return `${command} failed (status ${status}); no output.`;
  return `${command} failed (status ${status}); command output omitted sha256=${sha256(output).slice(0, 16)}.`;
}

function parseGitNexusList(output: string): GitNexusListEntry[] {
  const entries: GitNexusListEntry[] = [];
  let current: GitNexusListEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    const aliasMatch = line.match(/^ {2}(\S.*\S|\S)$/);
    if (aliasMatch) {
      if (current) entries.push(current);
      current = { alias: aliasMatch[1]!.trim(), path: null, indexedAt: null, commit: null };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^ {4}([^:]+):\s*(.*)$/);
    if (!field) continue;
    const key = field[1]!.trim().toLowerCase();
    const value = field[2]!.trim();
    if (key === "path") current.path = value || null;
    if (key === "indexed") current.indexedAt = value || null;
    if (key === "commit") current.commit = value || null;
  }
  if (current) entries.push(current);
  return entries;
}

function indexFreshness(indexCommit: string | null, headSha: string | null): GitNexusFreshness {
  if (!indexCommit || !headSha) return "unknown";
  return headSha.startsWith(indexCommit) || indexCommit.startsWith(headSha) ? "fresh" : "stale";
}

function isGeneratedPath(file: string): boolean {
  return /(?:^|\/)__snapshots__\/|\.generated\.|\.snap(?:shot)?$|^protocol-generated\//i.test(file);
}

function containsSecretLikeText(text: string): boolean {
  return (
    /(?:api[_-]?key|secret|token|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/i.test(text) ||
    /\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_]{16,}/.test(text)
  );
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n...[truncated]`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
