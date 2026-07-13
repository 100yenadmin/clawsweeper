import type { ReleaseContract, ReleasePullMetadata } from "./contract.js";

export interface ReleasePathPolicy {
  exactPaths: readonly string[];
  prefixes: readonly string[];
  patterns?: readonly string[];
}

export interface ReleaseRepositoryPolicy {
  releasePreparation: ReleasePathPolicy;
  releaseInfrastructure: ReleasePathPolicy;
  productPathPrefixes?: readonly string[];
}

export type ReleaseChangeStatus =
  | "allowed"
  | "unclassified"
  | "pending-exception"
  | "blocked"
  | "incomplete";

export interface ReleaseChangeInput {
  sha: string;
  prNumber?: number;
  title: string;
  paths: readonly string[];
  contractIssue: number;
  contract: ReleaseContract;
  policy: ReleaseRepositoryPolicy;
  metadata?: ReleasePullMetadata;
  metadataMissingFields?: readonly string[];
  pathsComplete?: boolean;
  sourceMainReachable?: boolean;
  patchEquivalent?: boolean;
  collectionComplete?: boolean;
}

export interface ReleaseChangeDecision {
  status: ReleaseChangeStatus;
  reason: string;
  signals: string[];
}

export function classifyReleaseChange(input: ReleaseChangeInput): ReleaseChangeDecision {
  const signals = changeSignals(input.title, input.paths, input.policy);
  if (input.collectionComplete === false || input.pathsComplete === false) {
    return decision("incomplete", "change collection is incomplete", signals);
  }
  if (!input.prNumber) {
    return decision(
      "unclassified",
      "change is not associated with a release-target pull request",
      signals,
    );
  }
  if (!input.metadata) {
    const detail = input.metadataMissingFields?.join(", ") || "required release metadata";
    return decision("incomplete", `pull request is missing ${detail}`, signals);
  }
  if (input.metadata.contractIssue !== input.contractIssue) {
    return decision("blocked", "pull request references a different release contract", signals);
  }
  const releaseClass = input.metadata.releaseClass;
  if (!input.contract.allowedChangeClasses.includes(releaseClass)) {
    return decision(
      "blocked",
      `release class ${releaseClass} is not allowed by the contract`,
      signals,
    );
  }

  switch (releaseClass) {
    case "release-preparation":
      return pathsMatch(input.paths, input.policy.releasePreparation)
        ? decision("allowed", "paths match the repository release-preparation policy", signals)
        : decision("blocked", "paths exceed the repository release-preparation policy", signals);
    case "release-blocker":
      return input.metadata.blockerIssue
        ? decision("allowed", `release blocker cites #${input.metadata.blockerIssue}`, signals)
        : decision("incomplete", "release blocker does not cite a GitHub issue", signals);
    case "exact-backport":
      if (!input.metadata.sourceSha || !input.metadata.sourcePull) {
        return decision(
          "incomplete",
          "exact backport is missing a full source SHA or pull request",
          signals,
        );
      }
      if (input.sourceMainReachable === undefined || input.patchEquivalent === undefined) {
        return decision(
          "incomplete",
          "exact backport proof requires a complete target checkout",
          signals,
        );
      }
      if (!input.sourceMainReachable) {
        return decision("blocked", "exact backport source SHA is not reachable from main", signals);
      }
      return input.patchEquivalent
        ? decision("allowed", "source is on main and stable patch-id is equivalent", signals)
        : decision(
            "blocked",
            "release change is not patch-equivalent to its source on main",
            signals,
          );
    case "release-infrastructure":
      return pathsMatch(input.paths, input.policy.releaseInfrastructure)
        ? decision("allowed", "paths match the repository release-infrastructure policy", signals)
        : decision("blocked", "paths exceed the repository release-infrastructure policy", signals);
    case "changelog-only":
      return input.paths.length === 1 && input.paths[0] === "CHANGELOG.md"
        ? decision("allowed", "complete path set is exactly CHANGELOG.md", signals)
        : decision("blocked", "changelog-only changes must modify exactly CHANGELOG.md", signals);
    case "exception":
      return classifyException(input, input.metadata, signals);
  }
}

function classifyException(
  input: ReleaseChangeInput,
  metadata: ReleasePullMetadata,
  signals: string[],
): ReleaseChangeDecision {
  const matchingExceptions = input.contract.approvedExceptions.filter(
    (candidate) => candidate.number === input.prNumber,
  );
  if (matchingExceptions.length > 1) {
    return decision("incomplete", "release contract contains duplicate exception entries", signals);
  }
  const exception = matchingExceptions[0];
  if (!exception) {
    return decision("blocked", "pull request is not listed under Approved exceptions", signals);
  }
  if (exception.decision === "pending") {
    if (!exception.decisionUrl || !metadata.exceptionDecisionUrl) {
      return decision("incomplete", "pending exception is missing its decision link", signals);
    }
    if (exception.decisionUrl !== metadata.exceptionDecisionUrl) {
      return decision(
        "blocked",
        "exception decision link does not match the release contract",
        signals,
      );
    }
    return decision("pending-exception", "exception decision is pending", signals);
  }
  if (exception.decision === "rejected") {
    return decision("blocked", "exception decision was rejected", signals);
  }
  if (exception.approver !== input.contract.captain) {
    return decision("blocked", "exception was not approved by the release captain", signals);
  }
  if (!exception.decisionUrl || !metadata.exceptionDecisionUrl) {
    return decision("incomplete", "approved exception is missing its decision link", signals);
  }
  if (exception.decisionUrl !== metadata.exceptionDecisionUrl) {
    return decision(
      "blocked",
      "exception decision link does not match the release contract",
      signals,
    );
  }
  return decision("allowed", "exception is listed and approved by the release captain", signals);
}

function pathsMatch(paths: readonly string[], policy: ReleasePathPolicy): boolean {
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        policy.exactPaths.includes(path) ||
        policy.prefixes.some((prefix) => path.startsWith(prefix)) ||
        (policy.patterns ?? []).some((pattern) => pathMatchesPattern(path, pattern)),
    )
  );
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  return (
    pathSegments.length === patternSegments.length &&
    patternSegments.every((segment, index) => segment === "*" || segment === pathSegments[index])
  );
}

function changeSignals(
  title: string,
  paths: readonly string[],
  policy: ReleaseRepositoryPolicy,
): string[] {
  const signals: string[] = [];
  if (/^feat(?:\([^)]*\))?[!:]/i.test(title.trim())) signals.push("feature-title");
  if (
    paths.some((path) =>
      (policy.productPathPrefixes ?? ["src/", "apps/", "packages/"]).some((prefix) =>
        path.startsWith(prefix),
      ),
    )
  ) {
    signals.push("product-or-runtime-path");
  }
  return signals;
}

function decision(
  status: ReleaseChangeStatus,
  reason: string,
  signals: string[],
): ReleaseChangeDecision {
  return { status, reason, signals };
}
