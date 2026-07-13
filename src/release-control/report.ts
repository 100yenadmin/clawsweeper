import { sortStable } from "../stable-json.js";
import {
  classifyReleaseChange,
  type ReleaseChangeStatus,
  type ReleaseRepositoryPolicy,
} from "./classifier.js";
import type { ReleaseClass, ReleaseContract, ReleasePullMetadata } from "./contract.js";

export type ReleaseAuditMode = "advisory" | "enforced";
export type ReleaseAuditStatus = "clear" | "attention" | "blocked" | "incomplete";

export interface ReleaseReportChangeInput {
  sha: string;
  prNumber?: number;
  prUrl?: string;
  title: string;
  paths: string[];
  pathsComplete?: boolean;
  metadata?: ReleasePullMetadata;
  metadataMissingFields?: string[];
  sourceMainReachable?: boolean;
  patchEquivalent?: boolean;
  collectionComplete?: boolean;
}

export interface ReleaseReportInput {
  targetRepo: string;
  train: string;
  releaseBranch: string;
  contractIssue: {
    number: number;
    url: string;
    updatedAt: string;
    bodyDigest: string;
  };
  contract: ReleaseContract;
  policy: ReleaseRepositoryPolicy;
  codeSha: string;
  releaseSha: string;
  headSha: string;
  latestBeta: string | null;
  mode: ReleaseAuditMode;
  evidenceTimestamp: string;
  collectionComplete: boolean;
  changes: ReleaseReportChangeInput[];
}

export interface ReleaseReportChange {
  sha: string;
  pr: { number: number; url: string } | null;
  title: string;
  paths: string[];
  declared_class: ReleaseClass | null;
  blocker: number | null;
  source: {
    sha: string;
    pr: number | null;
    main_reachable: boolean | null;
    patch_equivalent: boolean | null;
  } | null;
  signals: string[];
  status: ReleaseChangeStatus;
  reason: string;
  decision_packet_url: string | null;
}

export interface ReleaseReport {
  schema_version: 1;
  target_repo: string;
  train: string;
  release_branch: string;
  contract: {
    issue_number: number;
    issue_url: string;
    updated_at: string;
    body_digest: string;
  };
  cut_sha: string;
  code_sha: string;
  release_sha: string;
  head_sha: string;
  latest_beta: string | null;
  mode: ReleaseAuditMode;
  status: ReleaseAuditStatus;
  counts: {
    commits: number;
    prs: number;
    allowed: number;
    unclassified: number;
    pending_exceptions: number;
    product_change_signals: number;
    candidate_resets: number;
  };
  changes: ReleaseReportChange[];
  evidence: {
    timestamp: string;
    source_shas: {
      cut: string;
      code: string;
      release: string;
      head: string;
    };
  };
}

export function buildReleaseReport(input: ReleaseReportInput): ReleaseReport {
  const changes = input.changes
    .map((change) => releaseReportChange(input, change))
    .sort(
      (left, right) =>
        left.sha.localeCompare(right.sha) || (left.pr?.number ?? 0) - (right.pr?.number ?? 0),
    );
  const productChangeSignals = changes.reduce(
    (total, change) =>
      total +
      change.signals.filter(
        (signal) => signal === "feature-title" || signal === "product-or-runtime-path",
      ).length,
    0,
  );
  const candidateResets = changes.filter((change) =>
    /\b(?:reset|revert)\b/i.test(change.title),
  ).length;
  const status = reportStatus(
    input.collectionComplete,
    changes,
    productChangeSignals,
    candidateResets,
  );
  return {
    schema_version: 1,
    target_repo: input.targetRepo,
    train: input.train,
    release_branch: input.releaseBranch,
    contract: {
      issue_number: input.contractIssue.number,
      issue_url: input.contractIssue.url,
      updated_at: input.contractIssue.updatedAt,
      body_digest: input.contractIssue.bodyDigest,
    },
    cut_sha: input.contract.cutSha,
    code_sha: input.codeSha,
    release_sha: input.releaseSha,
    head_sha: input.headSha,
    latest_beta: input.latestBeta,
    mode: input.mode,
    status,
    counts: {
      commits: changes.length,
      prs: new Set(changes.flatMap((change) => (change.pr ? [change.pr.number] : []))).size,
      allowed: changes.filter((change) => change.status === "allowed").length,
      unclassified: changes.filter((change) => change.status === "unclassified").length,
      pending_exceptions: changes.filter((change) => change.status === "pending-exception").length,
      product_change_signals: productChangeSignals,
      candidate_resets: candidateResets,
    },
    changes,
    evidence: {
      timestamp: input.evidenceTimestamp,
      source_shas: {
        cut: input.contract.cutSha,
        code: input.codeSha,
        release: input.releaseSha,
        head: input.headSha,
      },
    },
  };
}

export function renderReleaseReportJson(report: ReleaseReport): string {
  return `${JSON.stringify(sortStable(report), null, 2)}\n`;
}

export function renderReleaseReportMarkdown(report: ReleaseReport): string {
  const lines = [
    `# Release control audit: ${report.train}`,
    "",
    `Status: **${report.status}**`,
    "",
    `- Target: \`${report.target_repo}\``,
    `- Release branch: \`${report.release_branch}\``,
    `- Mode: \`${report.mode}\``,
    `- Contract: [#${report.contract.issue_number}](${report.contract.issue_url})`,
    `- Cut SHA: \`${report.cut_sha}\``,
    `- Code SHA: \`${report.code_sha}\``,
    `- Release SHA: \`${report.release_sha}\``,
    `- Head SHA: \`${report.head_sha}\``,
    `- Latest beta: ${report.latest_beta ? `\`${report.latest_beta}\`` : "none"}`,
    `- Evidence timestamp: \`${report.evidence.timestamp}\``,
    "",
    "## Counts",
    "",
    "| Commits | PRs | Allowed | Unclassified | Pending exceptions | Product signals | Candidate resets |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.counts.commits} | ${report.counts.prs} | ${report.counts.allowed} | ${report.counts.unclassified} | ${report.counts.pending_exceptions} | ${report.counts.product_change_signals} | ${report.counts.candidate_resets} |`,
    "",
    "## Changes",
    "",
  ];
  if (report.changes.length === 0) {
    lines.push("No cut-to-head changes found.", "");
  } else {
    lines.push(
      "| SHA | PR | Class | Status | Title | Paths | Signals | Reason |",
      "| --- | ---: | --- | --- | --- | --- | --- | --- |",
    );
    for (const change of report.changes) {
      lines.push(
        `| \`${change.sha.slice(0, 12)}\` | ${change.pr ? `[#${change.pr.number}](${change.pr.url})` : "—"} | ${change.declared_class ?? "—"} | ${change.status} | ${escapeCell(change.title)} | ${escapeCell(change.paths.join("<br>"))} | ${escapeCell(change.signals.join(", ") || "—")} | ${escapeCell(change.reason)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "This report is read-only. It does not publish GitHub checks, comments, labels, or state.",
    "",
  );
  return lines.join("\n");
}

function releaseReportChange(
  input: ReleaseReportInput,
  change: ReleaseReportChangeInput,
): ReleaseReportChange {
  const classification = classifyReleaseChange({
    sha: change.sha,
    title: change.title,
    paths: change.paths,
    contractIssue: input.contractIssue.number,
    contract: input.contract,
    policy: input.policy,
    ...(change.prNumber === undefined ? {} : { prNumber: change.prNumber }),
    ...(change.metadata === undefined ? {} : { metadata: change.metadata }),
    ...(change.metadataMissingFields === undefined
      ? {}
      : { metadataMissingFields: change.metadataMissingFields }),
    ...(change.sourceMainReachable === undefined
      ? {}
      : { sourceMainReachable: change.sourceMainReachable }),
    ...(change.patchEquivalent === undefined ? {} : { patchEquivalent: change.patchEquivalent }),
    ...(change.collectionComplete === undefined
      ? {}
      : { collectionComplete: change.collectionComplete }),
    ...(change.pathsComplete === undefined ? {} : { pathsComplete: change.pathsComplete }),
  });
  const paths = [...new Set(change.paths)].sort();
  const metadata = change.metadata;
  return {
    sha: change.sha.toLowerCase(),
    pr:
      change.prNumber === undefined
        ? null
        : {
            number: change.prNumber,
            url: change.prUrl ?? `https://github.com/${input.targetRepo}/pull/${change.prNumber}`,
          },
    title: change.title,
    paths,
    declared_class: metadata?.releaseClass ?? null,
    blocker: metadata?.blockerIssue ?? null,
    source: metadata?.sourceSha
      ? {
          sha: metadata.sourceSha,
          pr: metadata.sourcePull ?? null,
          main_reachable: change.sourceMainReachable ?? null,
          patch_equivalent: change.patchEquivalent ?? null,
        }
      : null,
    signals: [...new Set(classification.signals)].sort(),
    status: classification.status,
    reason: classification.reason,
    decision_packet_url: metadata?.exceptionDecisionUrl ?? null,
  };
}

function reportStatus(
  collectionComplete: boolean,
  changes: readonly ReleaseReportChange[],
  productChangeSignals: number,
  candidateResets: number,
): ReleaseAuditStatus {
  if (!collectionComplete || changes.some((change) => change.status === "incomplete")) {
    return "incomplete";
  }
  if (changes.some((change) => change.status === "blocked")) return "blocked";
  if (
    changes.some(
      (change) => change.status === "unclassified" || change.status === "pending-exception",
    ) ||
    productChangeSignals > 0 ||
    candidateResets > 0
  ) {
    return "attention";
  }
  return "clear";
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
