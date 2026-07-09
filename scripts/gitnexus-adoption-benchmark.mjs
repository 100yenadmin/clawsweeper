#!/usr/bin/env node

const evalName = "clawsweeper-gitnexus-adoption-v0.1";
const allowedFreshness = new Set(["fresh", "stale", "missing", "unknown", "not_applicable"]);

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const result = buildResult(args);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {
    scenario: "dry-run",
    baselineTokens: 0,
    gitnexusTokens: 0,
    baselineRuntimeMs: 0,
    gitnexusRuntimeMs: 0,
    baselineToolCalls: 0,
    gitnexusToolCalls: 0,
    seededFindingsCaught: 0,
    seededFindingsTotal: 0,
    falsePositiveCount: 0,
    graphFreshness: "unknown",
    secretLeakageDetected: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--") continue;
    if (name === "--help" || name === "-h") {
      parsed.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    index += 1;
    switch (name) {
      case "--scenario":
        parsed.scenario = value;
        break;
      case "--baseline-tokens":
        parsed.baselineTokens = numberValue(name, value);
        break;
      case "--gitnexus-tokens":
        parsed.gitnexusTokens = numberValue(name, value);
        break;
      case "--baseline-runtime-ms":
        parsed.baselineRuntimeMs = numberValue(name, value);
        break;
      case "--gitnexus-runtime-ms":
        parsed.gitnexusRuntimeMs = numberValue(name, value);
        break;
      case "--baseline-tool-calls":
        parsed.baselineToolCalls = numberValue(name, value);
        break;
      case "--gitnexus-tool-calls":
        parsed.gitnexusToolCalls = numberValue(name, value);
        break;
      case "--seeded-findings-caught":
        parsed.seededFindingsCaught = numberValue(name, value);
        break;
      case "--seeded-findings-total":
        parsed.seededFindingsTotal = numberValue(name, value);
        break;
      case "--false-positive-count":
        parsed.falsePositiveCount = numberValue(name, value);
        break;
      case "--graph-freshness":
        if (!allowedFreshness.has(value)) {
          throw new Error(
            `Invalid --graph-freshness ${value}; expected one of ${[...allowedFreshness].join(", ")}`,
          );
        }
        parsed.graphFreshness = value;
        break;
      case "--secret-leakage-detected":
        parsed.secretLeakageDetected = booleanValue(name, value);
        break;
      default:
        throw new Error(`Unknown option ${name}`);
    }
  }

  return parsed;
}

function buildResult(values) {
  return {
    evalName,
    scenario: values.scenario,
    baselineTokens: values.baselineTokens,
    gitnexusTokens: values.gitnexusTokens,
    tokenDeltaPercent: reductionPercent(values.baselineTokens, values.gitnexusTokens),
    baselineRuntimeMs: values.baselineRuntimeMs,
    gitnexusRuntimeMs: values.gitnexusRuntimeMs,
    runtimeDeltaPercent: reductionPercent(values.baselineRuntimeMs, values.gitnexusRuntimeMs),
    baselineToolCalls: values.baselineToolCalls,
    gitnexusToolCalls: values.gitnexusToolCalls,
    toolCallDelta: values.baselineToolCalls - values.gitnexusToolCalls,
    seededFindingsCaught: values.seededFindingsCaught,
    seededFindingsTotal: values.seededFindingsTotal,
    falsePositiveCount: values.falsePositiveCount,
    graphFreshness: values.graphFreshness,
    secretLeakageDetected: values.secretLeakageDetected,
  };
}

function reductionPercent(baseline, candidate) {
  if (baseline <= 0) return 0;
  return Number((((baseline - candidate) / baseline) * 100).toFixed(2));
}

function numberValue(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function booleanValue(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function printHelp() {
  process.stdout.write(`Usage: pnpm run gitnexus:benchmark -- [options]

Options:
  --scenario <name>
  --baseline-tokens <number>
  --gitnexus-tokens <number>
  --baseline-runtime-ms <number>
  --gitnexus-runtime-ms <number>
  --baseline-tool-calls <number>
  --gitnexus-tool-calls <number>
  --seeded-findings-caught <number>
  --seeded-findings-total <number>
  --false-positive-count <number>
  --graph-freshness <fresh|stale|missing|unknown|not_applicable>
  --secret-leakage-detected <true|false>
`);
}
