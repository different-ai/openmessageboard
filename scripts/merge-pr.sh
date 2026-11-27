#!/usr/bin/env bash
# Squash-merges a pull request into main at exactly the commit CI approved,
# then shows that every rule on main passed (so no bypass was used).
#
#   scripts/merge-pr.sh <pr number>      (or: make merge PR=<pr number>)
#
# `gh pr merge` refuses these pull requests ("the base branch policy prohibits
# the merge") even when every rule is met, so this calls the merge mutation
# directly. It never uses administrator privileges.
set -euo pipefail

pr="${1:?usage: scripts/merge-pr.sh <pr number>}"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

IFS=$'\t' read -r id head decision state base < <(
  gh pr view "$pr" --json id,headRefOid,reviewDecision,state,baseRefName \
    --jq '[.id, .headRefOid, .reviewDecision, .state, .baseRefName] | @tsv'
)
[ "$state" = "OPEN" ] || { echo "PR #$pr is $state, not open" >&2; exit 1; }
[ "$base" = "main" ] || { echo "PR #$pr targets $base, not main" >&2; exit 1; }
[ "$decision" = "APPROVED" ] || { echo "PR #$pr is not approved ($decision); wait for CI's approval" >&2; exit 1; }

# Every check must have passed or been skipped.
not_green="$(gh pr checks "$pr" --json name,bucket --jq '[.[] | select(.bucket != "pass" and .bucket != "skipping") | .name + " (" + .bucket + ")"] | join(", ")')"
[ -z "$not_green" ] || { echo "PR #$pr has checks that are not green: $not_green" >&2; exit 1; }

merged="$(gh api graphql \
  -f query='mutation($id: ID!, $oid: GitObjectID!) { mergePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid, mergeMethod: SQUASH}) { pullRequest { mergeCommit { oid } } } }' \
  -f id="$id" -f oid="$head" --jq '.data.mergePullRequest.pullRequest.mergeCommit.oid')"
echo "merged #$pr at $head as $merged"

# The rule suite for the push appears a few seconds after the merge.
for _ in 1 2 3 4 5 6; do
  suite="$(gh api "repos/$repo/rulesets/rule-suites?ref=refs/heads/main&per_page=5" --jq "[.[] | select(.after_sha == \"$merged\")][0].id // empty")"
  [ -n "$suite" ] && break
  sleep 5
done
[ -n "${suite:-}" ] || { echo "no rule suite found for $merged yet; check it by hand" >&2; exit 1; }
gh api "repos/$repo/rulesets/rule-suites/$suite" --jq '.rule_evaluations[] | "  " + .rule_type + ": " + .result'
failed="$(gh api "repos/$repo/rulesets/rule-suites/$suite" --jq '[.rule_evaluations[] | select(.result != "pass") | .rule_type] | join(", ")')"
[ -z "$failed" ] || { echo "rules that did not pass: $failed. The merge used a bypass: say so in the PR and fix the cause." >&2; exit 1; }
