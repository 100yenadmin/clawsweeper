import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReleaseContract,
  parseReleasePullMetadata,
} from "../dist/release-control/contract.js";

function contractWithExceptions(approvedExceptions: string): string {
  return `
## Release train
2026.7.2
## Release captain
@alice
## Goal
Ship a narrow beta.
## Non-goals
No product work.
## Cut SHA
0123456789abcdef0123456789abcdef01234567
## Allowed change classes
- exception
## Exit criteria
Checks pass.
## Approved exceptions
${approvedExceptions}
`;
}

test("parses the release contract and release-target pull request metadata", () => {
  const contract = parseReleaseContract(`
## Release train
2026.7.2

## Release captain
@alice

## Goal
Ship a narrow beta.

## Non-goals
No new runtime features.

## Cut SHA
0123456789abcdef0123456789abcdef01234567

## Allowed change classes
- release-preparation
- release-blocker
- exact-backport
- release-infrastructure
- changelog-only
- exception

## Exit criteria
All release checks pass.

## Approved exceptions
- #991: approved by @alice (https://github.com/openclaw/openclaw/issues/900#issuecomment-1)
`);

  assert.deepEqual(contract.missingFields, []);
  assert.equal(contract.value?.train, "2026.7.2");
  assert.equal(contract.value?.captain, "alice");
  assert.equal(contract.value?.cutSha, "0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(contract.value?.approvedExceptions, [
    {
      number: 991,
      approver: "alice",
      decisionUrl: "https://github.com/openclaw/openclaw/issues/900#issuecomment-1",
      decision: "approved",
    },
  ]);

  const metadata = parseReleasePullMetadata(`
Release train: #900
Release class: exact-backport
Blocker: not applicable
Source on main: 89abcdef0123456789abcdef0123456789abcdef and #881
Exception decision: not required
`);

  assert.deepEqual(metadata.missingFields, []);
  assert.equal(metadata.value?.contractIssue, 900);
  assert.equal(metadata.value?.releaseClass, "exact-backport");
  assert.equal(metadata.value?.sourceSha, "89abcdef0123456789abcdef0123456789abcdef");
  assert.equal(metadata.value?.sourcePull, 881);
});

test("treats blank required contract fields and malformed pull metadata as incomplete", () => {
  const contract = parseReleaseContract(`
## Release train
2026.7.2
## Release captain
@alice
## Goal

## Non-goals
No product work.
## Cut SHA
not-a-full-sha
## Allowed change classes
- changelog-only
## Exit criteria
Checks pass.
## Approved exceptions
None.
`);

  assert.equal(contract.value, null);
  assert.deepEqual(contract.missingFields.sort(), ["Cut SHA", "Goal"]);

  const metadata = parseReleasePullMetadata(`
Release train: #900
Release class: feature
Blocker: not applicable
Source on main: not applicable
Exception decision: not required
`);
  assert.equal(metadata.value, null);
  assert.deepEqual(metadata.missingFields, ["Release class"]);
});

test("rejects duplicate and conflicting approved-exception entries", () => {
  const contract = parseReleaseContract(
    contractWithExceptions(`
- #991: approved by @alice (https://github.com/openclaw/openclaw/issues/900#issuecomment-1)
- #991: rejected by @alice (https://github.com/openclaw/openclaw/issues/900#issuecomment-2)
`),
  );

  assert.equal(contract.value, null);
  assert.deepEqual(contract.missingFields, ["Approved exceptions"]);
});

test("accepts only explicit approved, rejected, pending, or None exception grammar", () => {
  const contract = parseReleaseContract(
    contractWithExceptions(`
- #991: APPROVED by @alice (https://github.com/openclaw/openclaw/issues/900#issuecomment-1)
* #992: Rejected BY @alice (https://github.com/openclaw/openclaw/pull/992#issuecomment-2)
#993: Pending (https://github.com/openclaw/openclaw/issues/900#issuecomment-3)
`),
  );
  assert.deepEqual(contract.missingFields, []);
  assert.deepEqual(
    contract.value?.approvedExceptions.map(({ number, decision }) => ({ number, decision })),
    [
      { number: 991, decision: "approved" },
      { number: 992, decision: "rejected" },
      { number: 993, decision: "pending" },
    ],
  );
  assert.deepEqual(parseReleaseContract(contractWithExceptions("None.")).missingFields, []);

  const decisionUrl = "https://github.com/openclaw/openclaw/issues/900#issuecomment-106";
  for (const invalid of [
    `#106: not approved by @alice (${decisionUrl})`,
    `#106: maybe (${decisionUrl})`,
    "#106: approved by @alice",
    `#106: approved (${decisionUrl})`,
    `#106: approved by @alice (${decisionUrl}) after review`,
    "#106: approved by @alice (https://github.com/openclaw/openclaw/issues/900)",
    `Decision #106: approved by @alice (${decisionUrl})`,
    `None.\n#106: approved by @alice (${decisionUrl})`,
  ]) {
    const result = parseReleaseContract(contractWithExceptions(invalid));
    assert.equal(result.value, null, invalid);
    assert.deepEqual(result.missingFields, ["Approved exceptions"], invalid);
  }
});
