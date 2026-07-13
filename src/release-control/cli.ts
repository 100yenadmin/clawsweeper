import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, type Args } from "../clawsweeper-args.js";
import { runText, resolveCommand } from "../command.js";
import { parseGhJson } from "../github-json.js";
import type { ReleaseRepositoryPolicy } from "./classifier.js";
import {
  RELEASE_CLASSES,
  parseReleaseContract,
  parseReleasePullMetadata,
  type ReleaseContract,
} from "./contract.js";
import {
  buildReleaseReport,
  renderReleaseReportJson,
  renderReleaseReportMarkdown,
  type ReleaseAuditMode,
  type ReleaseReportChangeInput,
  type ReleaseReportInput,
} from "./report.js";

export interface ReleaseControlOptions {
  repo: string;
  releaseBranch: string;
  train: string;
  contractIssue: number;
  mode: ReleaseAuditMode;
  output: string;
  targetCheckout?: string;
}

export function parseReleaseControlArgs(argv: string[]): ReleaseControlOptions {
  return releaseControlOptions(parseArgs(argv));
}

export function releaseControlAuditCommand(args: Args): void {
  const options = releaseControlOptions(args);
  const report = buildReleaseReport(collectReleaseReportInput(options));
  mkdirSync(options.output, { recursive: true });
  const jsonPath = join(options.output, `${options.train}.json`);
  const markdownPath = join(options.output, `${options.train}.md`);
  writeFileSync(jsonPath, renderReleaseReportJson(report), "utf8");
  writeFileSync(markdownPath, renderReleaseReportMarkdown(report), "utf8");
  console.log(JSON.stringify({ json: jsonPath, markdown: markdownPath, status: report.status }));
}

function releaseControlOptions(args: Args): ReleaseControlOptions {
  const repo = requiredString(args, "repo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("--repo must be owner/repo");
  }
  const releaseBranch = requiredString(args, "release_branch");
  const train = releaseBranch.match(/^release\/([0-9]{4}\.[0-9]+\.[0-9]+)$/)?.[1];
  if (!train) throw new Error("--release-branch must match release/YYYY.M.PATCH");
  const contractIssue = Number(requiredString(args, "contract_issue"));
  if (!Number.isSafeInteger(contractIssue) || contractIssue <= 0) {
    throw new Error("--contract-issue must be a positive integer");
  }
  const mode = requiredString(args, "mode");
  if (mode !== "advisory" && mode !== "enforced") {
    throw new Error("--mode must be advisory or enforced");
  }
  const output = resolve(requiredString(args, "output"));
  const targetCheckoutValue = args.target_checkout;
  const options: ReleaseControlOptions = {
    repo: repo.toLowerCase(),
    releaseBranch,
    train,
    contractIssue,
    mode,
    output,
  };
  if (typeof targetCheckoutValue === "string" && targetCheckoutValue.trim()) {
    options.targetCheckout = resolve(targetCheckoutValue);
  }
  return options;
}

function requiredString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return value.trim();
}

interface GitHubIssue {
  number?: number;
  html_url?: string;
  updated_at?: string;
  body?: string | null;
}

interface GitHubRef {
  object?: { sha?: string; type?: string };
}

interface GitHubTag {
  sha?: string;
  object?: { sha?: string; type?: string };
}

interface GitHubRelease {
  id?: number;
  tag_name?: string;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string | null;
  created_at?: string;
  body?: string | null;
}

interface GitHubCompare {
  status?: string;
  total_commits?: number;
  commits?: Array<{ sha?: string }>;
  base_commit?: { sha?: string };
  merge_base_commit?: { sha?: string };
}

interface GitHubCommit {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  commit?: {
    message?: string;
    committer?: { date?: string };
  };
  files?: Array<{ filename?: string }>;
}

interface GitHubPull {
  number?: number;
  html_url?: string;
  body?: string | null;
  base?: { ref?: string };
}

interface GitHubAssociatedPulls {
  data?: {
    repository?: {
      object?: {
        associatedPullRequests?: {
          nodes?: Array<{
            number?: number;
            url?: string;
            body?: string | null;
            baseRefName?: string;
          }>;
          pageInfo?: { hasNextPage?: boolean };
        };
      };
    };
  };
}

interface ReleasePolicyFile {
  schema_version: number;
  repositories: Record<
    string,
    {
      release_preparation: { exact_paths: string[]; prefixes: string[]; patterns?: string[] };
      release_infrastructure: { exact_paths: string[]; prefixes: string[]; patterns?: string[] };
      product_path_prefixes?: string[];
    }
  >;
}

const MAX_RELEASE_PAGES = 10;
const MAX_TAG_DEREFERENCE_DEPTH = 5;

function collectReleaseReportInput(options: ReleaseControlOptions): ReleaseReportInput {
  let collectionComplete = true;
  const evidenceTimes: string[] = [];
  const policy = releasePolicyFor(options.repo);
  const issueResult = tryGhJson<GitHubIssue>(
    `repos/${options.repo}/issues/${options.contractIssue}`,
  );
  if (!issueResult.value) collectionComplete = false;
  const issue = issueResult.value ?? {};
  if (issue.updated_at) evidenceTimes.push(issue.updated_at);
  const body = issue.body ?? "";
  const parsedContract = parseReleaseContract(body);
  if (!parsedContract.value) collectionComplete = false;
  const contract = parsedContract.value ?? fallbackContract(options.train);
  if (contract.train !== options.train) collectionComplete = false;

  const refResult = tryGhJson<GitHubRef>(
    `repos/${options.repo}/git/ref/heads/${encodeURIComponent(options.releaseBranch)}`,
  );
  const headSha = fullSha(refResult.value?.object?.sha) ?? "";
  if (!headSha) collectionComplete = false;

  const releasesResult = collectReleases(options.repo);
  if (!releasesResult.complete) collectionComplete = false;
  const latestBeta = releasesResult.releases
    .filter(
      (release) =>
        release.prerelease === true &&
        release.draft !== true &&
        releaseTagMatchesTrain(release.tag_name, options.train),
    )
    .sort(
      (left, right) =>
        releaseTime(right).localeCompare(releaseTime(left)) || (right.id ?? 0) - (left.id ?? 0),
    )[0];
  if (latestBeta && releaseTime(latestBeta)) evidenceTimes.push(releaseTime(latestBeta));
  const releaseSha = labeledSha(latestBeta?.body ?? "", "Release SHA") ?? "";
  const releaseTagSha = latestBeta?.tag_name
    ? resolveTagCommit(options.repo, latestBeta.tag_name)
    : undefined;
  const releaseCommitCollection = releaseSha
    ? collectCommit(options.repo, releaseSha)
    : { value: null, paths: [], complete: false };
  const releaseCommit = releaseCommitCollection.value;
  const releasePaths = releaseCommitCollection.paths;
  const releaseParentSha =
    releaseCommit?.parents?.length === 1 ? fullSha(releaseCommit.parents[0]?.sha) : undefined;
  const codeSha =
    releaseCommitCollection.complete &&
    releasePaths.length === 1 &&
    releasePaths[0] === "CHANGELOG.md"
      ? (releaseParentSha ?? "")
      : "";
  if (releaseCommit?.commit?.committer?.date) {
    evidenceTimes.push(releaseCommit.commit.committer.date);
  }
  if (
    !latestBeta ||
    !codeSha ||
    !releaseSha ||
    !latestBeta.tag_name ||
    releaseTagSha !== releaseSha ||
    fullSha(releaseCommit?.sha) !== releaseSha
  ) {
    collectionComplete = false;
  }
  if (
    !contract.cutSha ||
    !codeSha ||
    !completeAncestorRelation(options.repo, contract.cutSha, codeSha)
  ) {
    collectionComplete = false;
  }
  if (!releaseSha || !headSha || !completeAncestorRelation(options.repo, releaseSha, headSha)) {
    collectionComplete = false;
  }

  const changes: ReleaseReportChangeInput[] = [];
  if (contract.cutSha && headSha) {
    const compareResult = tryGhJson<GitHubCompare>(
      `repos/${options.repo}/compare/${contract.cutSha}...${headSha}`,
    );
    const compare = compareResult.value;
    const commits = compare?.commits;
    if (!completeCompare(compare, contract.cutSha, headSha) || !commits) {
      collectionComplete = false;
    } else {
      for (const summary of commits) {
        const sha = fullSha(summary.sha) ?? "";
        if (!sha) {
          collectionComplete = false;
          continue;
        }
        changes.push(collectChange(options, contract, sha, evidenceTimes));
      }
    }
  } else {
    collectionComplete = false;
  }
  if (changes.some((change) => change.collectionComplete === false)) collectionComplete = false;

  return {
    targetRepo: options.repo,
    train: options.train,
    releaseBranch: options.releaseBranch,
    contractIssue: {
      number: options.contractIssue,
      url: issue.html_url ?? `https://github.com/${options.repo}/issues/${options.contractIssue}`,
      updatedAt: issue.updated_at ?? "",
      bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    },
    contract,
    policy,
    codeSha,
    releaseSha,
    headSha,
    latestBeta: latestBeta?.tag_name ?? null,
    mode: options.mode,
    evidenceTimestamp: deterministicEvidenceTimestamp(evidenceTimes),
    collectionComplete,
    changes,
  };
}

function collectReleases(repo: string): { releases: GitHubRelease[]; complete: boolean } {
  const releases: GitHubRelease[] = [];
  const ids = new Set<number>();
  const tags = new Set<string>();
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const result = tryGhJson<unknown>(`repos/${repo}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(result.value) || result.value.length > 100) {
      return { releases, complete: false };
    }
    for (const value of result.value) {
      if (!validRelease(value)) return { releases, complete: false };
      const id = value.id!;
      const tag = value.tag_name!.toLowerCase();
      if (ids.has(id) || tags.has(tag)) return { releases, complete: false };
      ids.add(id);
      tags.add(tag);
      releases.push(value);
    }
    if (result.value.length < 100) return { releases, complete: true };
  }
  return { releases, complete: false };
}

function validRelease(value: unknown): value is GitHubRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as GitHubRelease;
  return (
    Number.isSafeInteger(release.id) &&
    (release.id ?? 0) > 0 &&
    typeof release.tag_name === "string" &&
    release.tag_name.length > 0 &&
    release.tag_name === release.tag_name.trim() &&
    typeof release.prerelease === "boolean" &&
    typeof release.draft === "boolean" &&
    typeof release.created_at === "string" &&
    release.created_at.length > 0 &&
    (release.published_at === undefined ||
      release.published_at === null ||
      typeof release.published_at === "string") &&
    (release.body === undefined || release.body === null || typeof release.body === "string")
  );
}

function resolveTagCommit(repo: string, tag: string): string | undefined {
  let object = tryGhJson<GitHubRef>(`repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`).value
    ?.object;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_TAG_DEREFERENCE_DEPTH; depth += 1) {
    const sha = fullSha(object?.sha);
    if (!sha) return undefined;
    if (object?.type === "commit") return sha;
    if (object?.type !== "tag" || seen.has(sha)) return undefined;
    seen.add(sha);
    const tagObject = tryGhJson<GitHubTag>(`repos/${repo}/git/tags/${sha}`).value;
    if (!tagObject || fullSha(tagObject.sha) !== sha) return undefined;
    object = tagObject.object;
  }
  return undefined;
}

function completeAncestorRelation(repo: string, base: string, head: string): boolean {
  return completeCompare(
    tryGhJson<GitHubCompare>(`repos/${repo}/compare/${base}...${head}`).value,
    base,
    head,
  );
}

function completeCompare(compare: GitHubCompare | null, base: string, head: string): boolean {
  if (
    !compare ||
    !Array.isArray(compare.commits) ||
    !Number.isSafeInteger(compare.total_commits) ||
    (compare.total_commits ?? -1) < 0 ||
    compare.total_commits !== compare.commits.length ||
    fullSha(compare.base_commit?.sha) !== base ||
    fullSha(compare.merge_base_commit?.sha) !== base ||
    compare.commits.some((commit) => !fullSha(commit.sha))
  ) {
    return false;
  }
  if (compare.status === "identical") {
    return base === head && compare.commits.length === 0;
  }
  return (
    compare.status === "ahead" && base !== head && fullSha(compare.commits.at(-1)?.sha) === head
  );
}

function collectChange(
  options: ReleaseControlOptions,
  contract: ReleaseContract,
  sha: string,
  evidenceTimes: string[],
): ReleaseReportChangeInput {
  let collectionComplete = true;
  const commitResult = collectCommit(options.repo, sha);
  const commit = commitResult.value;
  if (!commit) collectionComplete = false;
  const title = commit?.commit?.message?.split("\n", 1)[0]?.trim() || sha;
  if (commit?.commit?.committer?.date) evidenceTimes.push(commit.commit.committer.date);
  const paths = commitResult.paths;
  const pathsComplete = commitResult.complete;
  if (!pathsComplete) collectionComplete = false;

  const pullsResult = associatedPulls(options.repo, sha);
  if (!pullsResult.complete) collectionComplete = false;
  const pulls = pullsResult.pulls
    .filter((pull) => pull.base?.ref === options.releaseBranch && Number.isSafeInteger(pull.number))
    .sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
  if (pulls.length > 1) collectionComplete = false;
  const pull = pulls[0];
  const parsedMetadata = pull
    ? parseReleasePullMetadata(pull.body ?? "")
    : { value: null, missingFields: [] as string[] };
  if (pull && !parsedMetadata.value) collectionComplete = false;
  const proof =
    parsedMetadata.value?.releaseClass === "exact-backport"
      ? exactBackportProof(
          options.repo,
          options.targetCheckout,
          parsedMetadata.value.sourceSha,
          sha,
        )
      : {};

  return {
    sha,
    title,
    paths,
    pathsComplete,
    collectionComplete,
    ...(pull?.number === undefined ? {} : { prNumber: pull.number }),
    ...(pull?.html_url === undefined ? {} : { prUrl: pull.html_url }),
    ...(parsedMetadata.value === null ? {} : { metadata: parsedMetadata.value }),
    ...(pull && parsedMetadata.missingFields.length > 0
      ? { metadataMissingFields: parsedMetadata.missingFields }
      : {}),
    ...proof,
  };
}

function collectCommit(
  repo: string,
  sha: string,
): { value: GitHubCommit | null; paths: string[]; complete: boolean } {
  let first: GitHubCommit | null = null;
  const paths: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const result = tryGhJson<GitHubCommit>(
      `repos/${repo}/commits/${sha}?per_page=100&page=${page}`,
    );
    const commit = result.value;
    if (!commit || fullSha(commit.sha) !== sha || !Array.isArray(commit.files)) {
      return { value: first, paths: [...new Set(paths)].sort(), complete: false };
    }
    first ??= commit;
    const pagePaths = commit.files.flatMap((file) => (file.filename ? [file.filename] : []));
    if (pagePaths.length !== commit.files.length) {
      return { value: first, paths: [...new Set(paths)].sort(), complete: false };
    }
    paths.push(...pagePaths);
    if (commit.files.length < 100) {
      const uniquePaths = [...new Set(paths)].sort();
      return { value: first, paths: uniquePaths, complete: uniquePaths.length === paths.length };
    }
  }
  return { value: first, paths: [...new Set(paths)].sort(), complete: false };
}

function associatedPulls(repo: string, sha: string): { pulls: GitHubPull[]; complete: boolean } {
  const [owner, name] = repo.split("/", 2);
  const query = `query($owner:String!,$name:String!,$sha:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$sha){... on Commit{associatedPullRequests(first:100){nodes{number url body baseRefName}pageInfo{hasNextPage}}}}}}`;
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `sha=${sha}`,
  ];
  const result = tryGhJsonArgs<GitHubAssociatedPulls>(args);
  const connection = result.value?.data?.repository?.object?.associatedPullRequests;
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    connection.pageInfo?.hasNextPage !== false
  ) {
    return { pulls: [], complete: false };
  }
  const pulls = connection.nodes.map((pull) => ({
    ...(pull.number === undefined ? {} : { number: pull.number }),
    ...(pull.url === undefined ? {} : { html_url: pull.url }),
    ...(pull.body === undefined ? {} : { body: pull.body }),
    ...(pull.baseRefName === undefined ? {} : { base: { ref: pull.baseRefName } }),
  }));
  return { pulls, complete: true };
}

export function exactBackportProof(
  repo: string,
  checkout: string | undefined,
  sourceSha: string | undefined,
  releaseSha: string,
): Pick<ReleaseReportChangeInput, "sourceMainReachable" | "patchEquivalent"> {
  if (!checkout || !sourceSha) return {};
  const githubMainSha = fullSha(
    tryGhJson<GitHubRef>(`repos/${repo}/git/ref/heads/main`).value?.object?.sha,
  );
  if (!githubMainSha) return {};
  return verifyExactBackport(checkout, sourceSha, releaseSha, githubMainSha);
}

export function verifyExactBackport(
  checkout: string,
  sourceSha: string,
  releaseSha: string,
  githubMainSha: string,
): Pick<ReleaseReportChangeInput, "sourceMainReachable" | "patchEquivalent"> {
  try {
    const insideWorktree = runText("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: checkout,
      trim: "both",
    });
    const shallow = runText("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: checkout,
      trim: "both",
    });
    const localMainSha = fullSha(
      runText("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], {
        cwd: checkout,
        trim: "both",
      }),
    );
    const localSourceSha = fullSha(
      runText("git", ["rev-parse", "--verify", `${sourceSha}^{commit}`], {
        cwd: checkout,
        trim: "both",
      }),
    );
    const localReleaseSha = fullSha(
      runText("git", ["rev-parse", "--verify", `${releaseSha}^{commit}`], {
        cwd: checkout,
        trim: "both",
      }),
    );
    if (
      insideWorktree !== "true" ||
      shallow !== "false" ||
      localMainSha !== githubMainSha ||
      localSourceSha !== sourceSha ||
      localReleaseSha !== releaseSha
    ) {
      return {};
    }
  } catch {
    return {};
  }
  const sourceMainReachable = gitAncestorResult(checkout, [
    "merge-base",
    "--is-ancestor",
    sourceSha,
    "refs/remotes/origin/main",
  ]);
  if (sourceMainReachable === undefined) return {};
  const sourcePatchId = gitPatchId(checkout, sourceSha);
  const releasePatchId = gitPatchId(checkout, releaseSha);
  return {
    sourceMainReachable,
    ...(sourcePatchId && releasePatchId
      ? { patchEquivalent: sourcePatchId === releasePatchId }
      : {}),
  };
}

function gitAncestorResult(cwd: string, args: string[]): boolean | undefined {
  try {
    const command = resolveCommand("git", args);
    const result = spawnSync(command.command, command.args, { cwd, stdio: "ignore" });
    if (result.error || result.signal) return undefined;
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function gitPatchId(cwd: string, sha: string): string | undefined {
  try {
    const diff = runText("git", ["show", "--first-parent", "--format=", "--binary", sha], {
      cwd,
      trim: "none",
    });
    const command = resolveCommand("git", ["patch-id", "--stable"]);
    const result = spawnSync(command.command, command.args, {
      cwd,
      input: diff,
      encoding: "utf8",
    });
    if (result.status !== 0) return undefined;
    return result.stdout.trim().split(/\s+/, 1)[0] || undefined;
  } catch {
    return undefined;
  }
}

function tryGhJson<T>(endpoint: string): { value: T | null } {
  return tryGhJsonArgs<T>(["api", endpoint]);
}

function tryGhJsonArgs<T>(args: string[]): { value: T | null } {
  try {
    return { value: parseGhJson<T>(runText("gh", args, { trim: "none" }), args) };
  } catch {
    return { value: null };
  }
}

function releasePolicyFor(repo: string): ReleaseRepositoryPolicy {
  const configPath = join(repositoryRoot(), "config", "release-control.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ReleasePolicyFile;
  if (config.schema_version !== 1) throw new Error("Unsupported release-control policy schema");
  const policy = config.repositories[repo];
  if (!policy) throw new Error(`No release-control path policy for ${repo}`);
  return {
    releasePreparation: {
      exactPaths: stringArray(
        policy.release_preparation.exact_paths,
        "release_preparation.exact_paths",
      ),
      prefixes: stringArray(policy.release_preparation.prefixes, "release_preparation.prefixes"),
      ...(policy.release_preparation.patterns
        ? {
            patterns: stringArray(
              policy.release_preparation.patterns,
              "release_preparation.patterns",
            ),
          }
        : {}),
    },
    releaseInfrastructure: {
      exactPaths: stringArray(
        policy.release_infrastructure.exact_paths,
        "release_infrastructure.exact_paths",
      ),
      prefixes: stringArray(
        policy.release_infrastructure.prefixes,
        "release_infrastructure.prefixes",
      ),
      ...(policy.release_infrastructure.patterns
        ? {
            patterns: stringArray(
              policy.release_infrastructure.patterns,
              "release_infrastructure.patterns",
            ),
          }
        : {}),
    },
    ...(policy.product_path_prefixes
      ? {
          productPathPrefixes: stringArray(policy.product_path_prefixes, "product_path_prefixes"),
        }
      : {}),
  };
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return [...value];
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function fallbackContract(train: string): ReleaseContract {
  return {
    train,
    captain: "unknown",
    goal: "missing",
    nonGoals: "missing",
    cutSha: "",
    allowedChangeClasses: [...RELEASE_CLASSES],
    exitCriteria: "missing",
    approvedExceptions: [],
  };
}

function fullSha(value: string | undefined): string | undefined {
  return value?.match(/^[0-9a-f]{40}$/i)?.[0]?.toLowerCase();
}

function labeledSha(body: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`^\\s*(?:[-*]\\s+)?${escaped}\\s*:\\s*(.*?)\\s*$`, "i");
  const values = body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(declaration);
      return match?.[1] === undefined ? [] : [match[1]];
    });
  if (values.length !== 1) return undefined;
  const sha = values[0]?.match(/^(?:`([0-9a-f]{40})`|([0-9a-f]{40}))$/i);
  return (sha?.[1] ?? sha?.[2])?.toLowerCase();
}

function releaseTagMatchesTrain(tag: string | undefined, train: string): boolean {
  if (!tag) return false;
  const escaped = train.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^v?${escaped}-beta(?:[.-][0-9A-Za-z.-]+)?$`, "i").test(tag);
}

function releaseTime(release: GitHubRelease): string {
  return release.published_at ?? release.created_at ?? "";
}

function deterministicEvidenceTimestamp(values: string[]): string {
  return [...values].filter(Boolean).sort().at(-1) ?? "1970-01-01T00:00:00.000Z";
}
