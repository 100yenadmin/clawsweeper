export type OpenClawDeepRegressionRiskLevel = "standard" | "high" | "critical";

export type OpenClawDeepRegressionSurfaceCategory =
  | "core"
  | "auth"
  | "session_state"
  | "runtime"
  | "security_boundary"
  | "provider_routing"
  | "migration"
  | "release_automation"
  | "config_defaults"
  | "generated_or_build_artifact"
  | "tests_only"
  | "docs_only";

export interface OpenClawDeepRegressionRiskFile {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface OpenClawDeepRegressionRiskPacket {
  packetVersion: "openclaw-deep-regression-risk-v0.1";
  riskLevel: OpenClawDeepRegressionRiskLevel;
  surfaceCategories: OpenClawDeepRegressionSurfaceCategory[];
  matchedFiles: string[];
  reasons: string[];
  requiredChecks: string[];
}

export interface OpenClawDeepRegressionRiskInput {
  repo: string;
  itemKind: "issue" | "pull_request";
  title?: string | undefined;
  body?: string | undefined;
  files?: readonly OpenClawDeepRegressionRiskFile[] | undefined;
}

const SOURCE_PREFIX = /^(?:src|packages|extensions|ui)\//;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.|-)test\.|\.spec\.[cm]?[jt]sx?$/i;
const DOC_PATH = /^(?:docs\/|README(?:\.[A-Za-z0-9_-]+)?$|CHANGELOG\.md$)|\.(?:md|mdx)$/i;
const GENERATED_PATH =
  /^(?:protocol-generated\/|docs\/\.generated\/)|(?:^|\/)__snapshots__\/|\.generated\.|\.snap(?:shot)?$/i;
const RELEASE_PATH =
  /^(?:\.github\/workflows\/|\.github\/actions\/)|(?:^|\/)(?:release|publish|version|changelog)/i;
const CONFIG_PATH =
  /(?:^|\/)(?:config|defaults?|settings?|schema)\b|(?:^|\/)openclaw\.json$|package\.json$|pnpm-workspace\.yaml$|tsconfig(?:\.[^.]+)?\.json$/i;
const CORE_SOURCE_PATH =
  /(?:^|\/)(?:core|runtime|agent|gateway|worker|session|auth|mcp|tool|channel)\b/i;

const CATEGORY_PATTERNS: readonly [OpenClawDeepRegressionSurfaceCategory, RegExp, string][] = [
  [
    "auth",
    /\b(?:auth|oauth|login|credential|credentials|token|tokens?|refresh|profile)\b/i,
    "Touches authentication, credentials, tokens, or login behavior.",
  ],
  [
    "session_state",
    /\b(?:session|state|checkpoint|conversation|thread|cursor|resume|persist|persistence)\b/i,
    "Touches session or persisted state behavior.",
  ],
  [
    "security_boundary",
    /\b(?:permission|sandbox|secret|secrets?|allowlist|denylist|policy|boundary|keychain)\b/i,
    "Touches a security or permission boundary.",
  ],
  [
    "runtime",
    /\b(?:runtime|gateway|server|worker|daemon|scheduler|queue|task|lease|mcp|tool|agent|channel)\b/i,
    "Touches runtime execution, workers, tools, or channel delivery.",
  ],
  [
    "provider_routing",
    /\b(?:provider|model|openai|anthropic|router|routing|fallback|selection)\b/i,
    "Touches model/provider routing or fallback behavior.",
  ],
  [
    "migration",
    /\b(?:migration|migrate|schema|database|sqlite)\b/i,
    "Touches storage, schema, or migration behavior.",
  ],
];

export function classifyOpenClawDeepRegressionRisk(
  input: OpenClawDeepRegressionRiskInput,
): OpenClawDeepRegressionRiskPacket {
  const files = (input.files ?? []).map((file) => normalizePath(file.path)).filter(Boolean);
  const categories = new Set<OpenClawDeepRegressionSurfaceCategory>();
  const reasons = new Set<string>();
  const matchedFiles = new Set<string>();

  if (
    input.repo.trim().toLowerCase() !== "openclaw/openclaw" ||
    input.itemKind !== "pull_request"
  ) {
    return packet(
      "standard",
      [],
      [],
      ["Deep regression routing is scoped to OpenClaw pull requests."],
      [],
    );
  }

  if (files.length > 0 && files.every((file) => DOC_PATH.test(file))) {
    return packet(
      "standard",
      ["docs_only"],
      files,
      ["Changed files are documentation-only, so deep regression review stays advisory."],
      ["Confirm no generated docs or examples hide executable runtime changes."],
    );
  }

  if (files.length > 0 && files.every((file) => TEST_PATH.test(file))) {
    return packet(
      "standard",
      ["tests_only"],
      files,
      ["Changed files are test-only, so deep regression review stays advisory."],
      [
        "Confirm tests describe the intended runtime contract and do not mask a broken implementation.",
      ],
    );
  }

  if (files.length > 0 && files.every((file) => GENERATED_PATH.test(file))) {
    return packet(
      "standard",
      ["generated_or_build_artifact"],
      files,
      ["Changed files are generated or snapshot artifacts only."],
      ["Confirm the generator or source artifact was reviewed in a separate change."],
    );
  }

  const searchableText = [input.title ?? "", input.body ?? "", ...files].join("\n");
  for (const file of files) {
    if (
      SOURCE_PREFIX.test(file) &&
      CORE_SOURCE_PATH.test(file) &&
      !TEST_PATH.test(file) &&
      !GENERATED_PATH.test(file)
    ) {
      categories.add("core");
      matchedFiles.add(file);
      reasons.add("Touches source code that may affect OpenClaw runtime behavior.");
    }
    if (RELEASE_PATH.test(file)) {
      categories.add("release_automation");
      matchedFiles.add(file);
      reasons.add("Touches release or CI automation.");
    }
    if (CONFIG_PATH.test(file)) {
      categories.add("config_defaults");
      matchedFiles.add(file);
      reasons.add("Touches configuration, schemas, defaults, or package-level settings.");
    }
  }

  for (const [category, pattern, reason] of CATEGORY_PATTERNS) {
    if (!pattern.test(searchableText)) continue;
    categories.add(category);
    reasons.add(reason);
    for (const file of files) {
      if (pattern.test(file)) matchedFiles.add(file);
    }
  }

  const categoryList = [...categories].sort();
  const highRiskRuntime =
    categoryList.includes("core") ||
    categoryList.includes("runtime") ||
    categoryList.includes("provider_routing") ||
    categoryList.includes("migration") ||
    categoryList.includes("release_automation") ||
    categoryList.includes("config_defaults");
  const hasCriticalBoundary =
    categoryList.includes("auth") ||
    categoryList.includes("session_state") ||
    categoryList.includes("security_boundary");
  const riskLevel: OpenClawDeepRegressionRiskLevel =
    hasCriticalBoundary && highRiskRuntime ? "critical" : categoryList.length ? "high" : "standard";

  return packet(
    riskLevel,
    categoryList,
    [...matchedFiles].sort(),
    [...reasons].sort(),
    requiredChecks(categoryList, riskLevel),
  );
}

export function renderOpenClawDeepRegressionRiskForPrompt(
  packet: OpenClawDeepRegressionRiskPacket,
): string {
  return [
    "## OpenClaw Deep Regression Risk",
    "",
    `Packet version: ${packet.packetVersion}`,
    `Risk level: ${packet.riskLevel}`,
    `Surface categories: ${packet.surfaceCategories.join(", ") || "none"}`,
    "",
    "Matched files:",
    ...(packet.matchedFiles.length ? packet.matchedFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Reasons:",
    ...(packet.reasons.length ? packet.reasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "Required checks:",
    ...(packet.requiredChecks.length
      ? packet.requiredChecks.map((check) => `- ${check}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function requiredChecks(
  categories: readonly OpenClawDeepRegressionSurfaceCategory[],
  riskLevel: OpenClawDeepRegressionRiskLevel,
): string[] {
  if (riskLevel === "standard") return [];
  const checks = new Set<string>();
  checks.add("Run an adversarial maintainer review for architecture fit and hidden regressions.");
  if (categories.includes("auth") || categories.includes("session_state")) {
    checks.add("Require exact auth/session-state proof before calling the PR safe.");
  }
  if (categories.includes("security_boundary")) {
    checks.add("Require explicit security-boundary reasoning and maintainer confirmation.");
  }
  if (categories.includes("runtime") || categories.includes("provider_routing")) {
    checks.add("Require runtime-path proof, not only unit tests or static review.");
  }
  if (categories.includes("release_automation") || categories.includes("config_defaults")) {
    checks.add("Check release/config defaults for backwards compatibility and rollback impact.");
  }
  return [...checks].sort();
}

function packet(
  riskLevel: OpenClawDeepRegressionRiskLevel,
  surfaceCategories: readonly OpenClawDeepRegressionSurfaceCategory[],
  matchedFiles: readonly string[],
  reasons: readonly string[],
  requiredChecks: readonly string[],
): OpenClawDeepRegressionRiskPacket {
  return {
    packetVersion: "openclaw-deep-regression-risk-v0.1",
    riskLevel,
    surfaceCategories: [...surfaceCategories],
    matchedFiles: [...matchedFiles],
    reasons: [...reasons],
    requiredChecks: [...requiredChecks],
  };
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/");
}
