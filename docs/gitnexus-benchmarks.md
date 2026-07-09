# GitNexus Benchmark Plan

Read when: measuring whether GitNexus-backed context actually improves
ClawSweeper cost, speed, or review accuracy.

## Goal

Measure the advisory value of GitNexus before maintainers make public cost or
accuracy claims.

The benchmark compares two review modes:

- baseline: ClawSweeper review without a GitNexus packet;
- GitNexus-enabled: ClawSweeper review with advisory graph context.

The benchmark does not prove release readiness. It only measures whether
GitNexus reduces repeated discovery work and improves review signal on the
selected scenarios.

## Required Metrics

Every benchmark run should emit JSON with these fields:

```json
{
  "evalName": "clawsweeper-gitnexus-adoption-v0.1",
  "scenario": "example",
  "baselineTokens": 100000,
  "gitnexusTokens": 60000,
  "tokenDeltaPercent": 40,
  "baselineRuntimeMs": 120000,
  "gitnexusRuntimeMs": 90000,
  "runtimeDeltaPercent": 25,
  "baselineToolCalls": 30,
  "gitnexusToolCalls": 18,
  "toolCallDelta": 12,
  "seededFindingsCaught": 3,
  "seededFindingsTotal": 3,
  "falsePositiveCount": 0,
  "graphFreshness": "fresh",
  "secretLeakageDetected": false
}
```

Positive `tokenDeltaPercent` and `runtimeDeltaPercent` mean the GitNexus-enabled
run used less of that resource than the baseline.

## Scenarios

Use a small, named scenario set before expanding:

- high-risk auth/session PR with seeded regression;
- core runtime/provider-routing PR with seeded regression;
- release automation/config-default PR;
- docs-only control PR;
- stale-index fixture;
- missing-index fixture;
- secret-like graph-output fixture.

Historical replay should include selected OpenClaw PRs from the 6.8 to 6.11
regression window, but only after maintainers agree which PRs are representative.

## Thresholds

For a successful adoption recommendation:

- zero secret leakage;
- stale graph context is never treated as fresh;
- docs-only controls do not block;
- seeded critical regressions produce `needs_attention` or `blocked`;
- benchmark output includes token, runtime, tool-call, accuracy, freshness, and
  secret-safety fields;
- any savings percentage is reported as measured for the dataset, not universal.

## Dry-Run Helper

Use the dry-run helper to normalize collected metrics into one JSON shape:

```sh
pnpm run gitnexus:benchmark -- \
  --scenario auth-session-seeded \
  --baseline-tokens 100000 \
  --gitnexus-tokens 60000 \
  --baseline-runtime-ms 120000 \
  --gitnexus-runtime-ms 90000 \
  --baseline-tool-calls 30 \
  --gitnexus-tool-calls 18 \
  --seeded-findings-caught 3 \
  --seeded-findings-total 3 \
  --false-positive-count 0 \
  --graph-freshness fresh
```

The helper does not run ClawSweeper by itself. It records comparable metrics
after a baseline and GitNexus-enabled review have already been collected.

## Evidence Packet

Store benchmark artifacts under:

```text
/Volumes/LEXAR/Codex/evidence/clawsweeper-gitnexus-adoption/2026-07-09/<issue-or-pr>/
```

Recommended files:

- `baseline-review.json`
- `gitnexus-review.json`
- `benchmark-summary.json`
- `redacted-gitnexus-packet.md`
- `ci-links.md`
- `notes.md`

## Reporting Rules

Acceptable:

- "On this benchmark set, GitNexus reduced tokens by 38%."
- "NeonDiff experience suggests larger savings may be possible, but this PR only
  claims the measured ClawSweeper result."
- "The graph was stale, so ClawSweeper correctly lowered confidence."

Not acceptable:

- "GitNexus saves 50%" without benchmark data.
- "GitNexus proves the PR is safe."
- "GitNexus replaces maintainer review."
- "GitNexus saw the whole repo" unless the evidence proves that exact claim.

