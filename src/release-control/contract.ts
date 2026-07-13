export const RELEASE_CLASSES = [
  "release-preparation",
  "release-blocker",
  "exact-backport",
  "release-infrastructure",
  "changelog-only",
  "exception",
] as const;

export type ReleaseClass = (typeof RELEASE_CLASSES)[number];

export interface ApprovedException {
  number: number;
  decision: "approved" | "pending" | "rejected";
  approver?: string;
  decisionUrl?: string;
}

export interface ReleaseContract {
  train: string;
  captain: string;
  goal: string;
  nonGoals: string;
  cutSha: string;
  allowedChangeClasses: ReleaseClass[];
  exitCriteria: string;
  approvedExceptions: ApprovedException[];
}

export interface ReleasePullMetadata {
  contractIssue: number;
  releaseClass: ReleaseClass;
  blockerIssue?: number;
  sourceSha?: string;
  sourcePull?: number;
  exceptionDecisionUrl?: string;
}

export interface ParseResult<T> {
  value: T | null;
  missingFields: string[];
}

const CONTRACT_FIELDS = [
  "Release train",
  "Release captain",
  "Goal",
  "Non-goals",
  "Cut SHA",
  "Allowed change classes",
  "Exit criteria",
  "Approved exceptions",
] as const;

const PULL_FIELDS = [
  "Release train",
  "Release class",
  "Blocker",
  "Source on main",
  "Exception decision",
] as const;

export function parseReleaseContract(body: string): ParseResult<ReleaseContract> {
  const fields = markdownFields(body, CONTRACT_FIELDS);
  const missingFields = CONTRACT_FIELDS.filter((field) => fields.get(field) === undefined);
  const train = fields.get("Release train")?.trim() ?? "";
  const captain = loginFrom(fields.get("Release captain") ?? "");
  const cutSha = fullShaFrom(fields.get("Cut SHA") ?? "");
  const allowedChangeClasses = releaseClassesFrom(fields.get("Allowed change classes") ?? "");
  const approvedExceptions = approvedExceptionsFrom(fields.get("Approved exceptions") ?? "");
  if (!train) addMissing(missingFields, "Release train");
  if (!captain) addMissing(missingFields, "Release captain");
  if (!fields.get("Goal")?.trim()) addMissing(missingFields, "Goal");
  if (!fields.get("Non-goals")?.trim()) addMissing(missingFields, "Non-goals");
  if (!cutSha) addMissing(missingFields, "Cut SHA");
  if (allowedChangeClasses.length === 0) addMissing(missingFields, "Allowed change classes");
  if (!fields.get("Exit criteria")?.trim()) addMissing(missingFields, "Exit criteria");
  if (!fields.get("Approved exceptions")?.trim()) addMissing(missingFields, "Approved exceptions");
  if (new Set(approvedExceptions.map((entry) => entry.number)).size !== approvedExceptions.length) {
    addMissing(missingFields, "Approved exceptions");
  }
  if (!captain || !cutSha || missingFields.length > 0) return { value: null, missingFields };

  return {
    value: {
      train,
      captain,
      goal: fields.get("Goal")!.trim(),
      nonGoals: fields.get("Non-goals")!.trim(),
      cutSha,
      allowedChangeClasses,
      exitCriteria: fields.get("Exit criteria")!.trim(),
      approvedExceptions,
    },
    missingFields: [],
  };
}

export function parseReleasePullMetadata(body: string): ParseResult<ReleasePullMetadata> {
  const fields = inlineFields(body, PULL_FIELDS);
  const missingFields = PULL_FIELDS.filter((field) => fields.get(field) === undefined);
  const contractIssue = issueNumberFrom(fields.get("Release train") ?? "");
  const releaseClass = releaseClassFrom(fields.get("Release class") ?? "");
  if (!contractIssue) addMissing(missingFields, "Release train");
  if (!releaseClass) addMissing(missingFields, "Release class");
  if (!contractIssue || !releaseClass || missingFields.length > 0) {
    return { value: null, missingFields };
  }

  const blocker = fields.get("Blocker")!;
  const source = fields.get("Source on main")!;
  const exceptionDecision = fields.get("Exception decision")!;
  const value: ReleasePullMetadata = { contractIssue, releaseClass };
  const blockerIssue = issueNumberFrom(blocker);
  const sourceSha = fullShaFrom(source);
  const sourcePull = issueNumberFrom(source);
  const exceptionDecisionUrl = urlFrom(exceptionDecision);
  if (blockerIssue) value.blockerIssue = blockerIssue;
  if (sourceSha) value.sourceSha = sourceSha;
  if (sourcePull) value.sourcePull = sourcePull;
  if (exceptionDecisionUrl) value.exceptionDecisionUrl = exceptionDecisionUrl;
  return { value, missingFields: [] };
}

function markdownFields(body: string, names: readonly string[]): Map<string, string> {
  const result = inlineFields(body, names);
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]?.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.trim();
    const name = names.find((candidate) => candidate.toLowerCase() === heading?.toLowerCase());
    if (!name) continue;
    const content: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{1,6}\s+/.test(lines[cursor] ?? "")) break;
      content.push(lines[cursor] ?? "");
    }
    result.set(name, content.join("\n").trim());
  }
  return result;
}

function inlineFields(body: string, names: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const name = names.find(
      (candidate) => candidate.toLowerCase() === (match[1] ?? "").trim().toLowerCase(),
    );
    if (name) result.set(name, (match[2] ?? "").trim());
  }
  return result;
}

function releaseClassesFrom(value: string): ReleaseClass[] {
  const found = RELEASE_CLASSES.filter((releaseClass) =>
    new RegExp(`(?:^|[^a-z-])${releaseClass}(?:$|[^a-z-])`, "i").test(value),
  );
  return [...found];
}

function releaseClassFrom(value: string): ReleaseClass | undefined {
  const normalized = value.trim().toLowerCase();
  return RELEASE_CLASSES.find((candidate) => candidate === normalized);
}

function approvedExceptionsFrom(value: string): ApprovedException[] {
  const exceptions: ApprovedException[] = [];
  for (const line of value.split("\n")) {
    const number = issueNumberFrom(line);
    if (!number) continue;
    const normalized = line.toLowerCase();
    const decision = normalized.includes("reject")
      ? "rejected"
      : normalized.includes("pending")
        ? "pending"
        : "approved";
    const entry: ApprovedException = { number, decision };
    const approverMatch = line.match(/(?:approved|rejected)\s+by\s+@?([A-Za-z0-9-]+)/i);
    const decisionUrl = urlFrom(line);
    if (approverMatch?.[1]) entry.approver = approverMatch[1];
    if (decisionUrl) entry.decisionUrl = decisionUrl;
    exceptions.push(entry);
  }
  return exceptions.sort((left, right) => left.number - right.number);
}

function issueNumberFrom(value: string): number | undefined {
  const match = value.match(/#(\d+)/);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function fullShaFrom(value: string): string | undefined {
  return value.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase();
}

function loginFrom(value: string): string | undefined {
  return value.match(/@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/)?.[1];
}

function urlFrom(value: string): string | undefined {
  return value.match(/https:\/\/github\.com\/[^\s)]+/)?.[0];
}

function addMissing(fields: string[], field: string): void {
  if (!fields.includes(field)) fields.push(field);
}
