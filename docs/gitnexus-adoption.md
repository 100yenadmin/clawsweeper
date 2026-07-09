# GitNexus Adoption Case

Read when: deciding whether ClawSweeper should enable GitNexus-backed review
context for OpenClaw PRs, or preparing the operational setup for that rollout.

## Plain-English Summary

GitNexus is a code map for large repositories. It indexes files, symbols,
callers, imports, and related execution paths so a reviewer can ask, "What code
is connected to this change?" without rediscovering the same repo structure on
every PR.

For ClawSweeper, the value is not "more AI." The value is better review context
with less repeated discovery work. A fresh GitNexus packet can help ClawSweeper
spend fewer model tokens searching for related code and more effort judging
whether the PR is actually safe.

PR #440 proposes the default-off hook for using GitNexus as advisory context.
This document explains why maintainers might enable that hook, how to operate
it, and what must be measured before making cost-saving claims. If PR #440 has
not merged yet, treat this page as the adoption proposal for the hook rather
than current `main` behavior.

## The Hypothesis

NeonDiff experience suggests GitNexus-backed context may produce significant
savings, potentially up to 50% in some review loops. ClawSweeper should treat
that as a hypothesis until it has its own benchmark data.

Acceptable public claim before benchmarks:

> GitNexus is expected to reduce repeated code-discovery work and may produce
> large token and runtime savings. ClawSweeper will benchmark the savings before
> treating any percentage as proven.

Do not claim that GitNexus guarantees a 50% reduction, catches every deep
regression, or proves release readiness.

## What GitNexus Gives ClawSweeper

Without GitNexus, ClawSweeper often has to gather context by asking broad
questions, searching files, and reading code around the changed files. That can
work, but it can also repeat the same discovery work across review runs.

With GitNexus enabled, ClawSweeper can request a compact context packet:

- changed files and symbol hints;
- nearby files, functions, methods, and classes;
- caller/import relationships;
- execution-flow or process hints when available;
- index freshness;
- omitted context, such as stale, empty, generated, or unsafe output;
- packet hashes for evidence and cache state.

This packet is advisory. GitHub's PR diff and the checked-out repository remain
authoritative.

## Where It Helps Most

GitNexus is most useful when a PR touches code where the important question is
not "does this line compile?" but "what else depends on this behavior?"

Good candidates:

- core runtime and session flow changes;
- auth, security, provider-routing, and release automation changes;
- refactors that move shared code paths;
- repeated review loops on the same high-risk PR;
- large PRs where search and context gathering dominate the review.

Poor candidates:

- docs-only changes;
- small typo or formatting fixes;
- repos without a fresh index;
- PRs where the graph output is missing, stale, or secret-like.

## Voyage AI Integration

Voyage AI is one possible embedding backend for GitNexus. It is not required by
ClawSweeper itself, but it is a practical option for code-search embeddings.

Current official Voyage docs say `voyage-code-3` includes 200M free text
embedding tokens per account, then paid usage after that:

- https://docs.voyageai.com/docs/pricing

The same docs family says rate-limit tiers can increase with billed usage or
purchased credits:

- https://docs.voyageai.com/docs/rate-limits

Verify both links before enablement. Provider pricing, rate limits, and free
tier terms can change.

Recommended GitNexus environment shape for a Voyage-backed setup:

```sh
GITNEXUS_EMBEDDING_URL=https://api.voyageai.com/v1
GITNEXUS_EMBEDDING_MODEL=voyage-code-3
GITNEXUS_EMBEDDING_DIMS=2048
GITNEXUS_EMBEDDING_API_KEY=<secret value from GitHub Actions secrets or operator storage>
```

Do not commit the API key. Do not print it in logs, evidence packets, PR
comments, or docs.

## Refresh Operations

GitNexus only helps when its index is fresh enough for the PR being reviewed.
The safe operating pattern is a deliberate refresh after merge batches, not a
per-commit hook.

Recommended flow:

1. A PR merges to the protected default branch.
2. A credential-gated workflow or operator job refreshes a clean checkout.
3. The job runs an incremental GitNexus analyze for the configured alias.
4. The job records the indexed commit, current commit, model, and evidence path.
5. ClawSweeper treats stale or missing index state as lower-confidence context.

Example operator command:

```sh
gitnexus analyze /path/to/openclaw-checkout \
  --name openclaw \
  --embeddings \
  --index-only
```

Workflow skeleton:

```yaml
name: GitNexus refresh

on:
  workflow_dispatch:
  schedule:
    - cron: "17 */6 * * *"

jobs:
  refresh:
    if: ${{ vars.CLAWSWEEPER_GITNEXUS_REFRESH_ENABLED == '1' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Refresh GitNexus index
        env:
          GITNEXUS_EMBEDDING_URL: ${{ vars.GITNEXUS_EMBEDDING_URL }}
          GITNEXUS_EMBEDDING_MODEL: ${{ vars.GITNEXUS_EMBEDDING_MODEL }}
          GITNEXUS_EMBEDDING_DIMS: ${{ vars.GITNEXUS_EMBEDDING_DIMS }}
          GITNEXUS_EMBEDDING_API_KEY: ${{ secrets.GITNEXUS_EMBEDDING_API_KEY }}
        run: |
          gitnexus analyze "$GITHUB_WORKSPACE" \
            --name openclaw \
            --embeddings \
            --index-only
```

Keep this disabled until maintainers approve credentials, runner cost, and
where the index should live.

## Rollout Decision

Before enabling GitNexus broadly, maintainers should have:

- benchmark evidence from `docs/gitnexus-benchmarks.md`;
- a fresh-index operating path;
- a credential owner for embeddings;
- a stale-index fallback policy;
- proof that secret-like graph output is omitted;
- and a clear public proof boundary.

The merge decision should be:

> We accept GitNexus as an optional code-map layer that may reduce repeated
> review discovery cost, with benchmarked savings reported separately and stale
> graph context treated as lower confidence.
