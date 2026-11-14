#!/usr/bin/env bash
# Passes only when every push-triggered run of the CI workflow for a commit finished with success.
# The CI run for a merge commit starts when the tag is pushed, so this waits while a run is queued
# or in progress, or while none is listed yet, up to CI_WAIT_SECONDS.
#
#   require-green-ci.sh <40-hex commit sha>
#
# Needs gh with a token that can read Actions runs (GH_TOKEN) and the repository in GH_REPO.
# CI_WAIT_SECONDS (default 1200) bounds the wait; CI_POLL_SECONDS (default 20) is the poll interval.
set -euo pipefail

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: require-green-ci.sh <40-hex commit sha>" >&2
  exit 2
fi
wait_s="${CI_WAIT_SECONDS:-1200}"
poll_s="${CI_POLL_SECONDS:-20}"
deadline=$(( $(date +%s) + wait_s ))

while :; do
  runs="$(gh api "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100" \
    --jq '.workflow_runs[] | [.status, (.conclusion // "none"), .html_url] | @tsv')"
  total=0
  pending=0
  failed=0
  while IFS=$'\t' read -r status conclusion url; do
    [ -n "$status" ] || continue
    total=$((total + 1))
    if [ "$status" != completed ]; then
      pending=$((pending + 1))
    elif [ "$conclusion" != success ]; then
      failed=1
      echo "::error::CI run for $sha concluded $conclusion: $url"
    fi
  done <<< "$runs"
  [ "$failed" -eq 0 ] || exit 1
  if [ "$total" -gt 0 ] && [ "$pending" -eq 0 ]; then
    echo "CI succeeded for $sha ($total run)"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$total" -eq 0 ]; then
      echo "::error::no CI run found for $sha after ${wait_s}s"
    else
      echo "::error::CI for $sha still running after ${wait_s}s"
    fi
    exit 1
  fi
  echo "waiting for CI on $sha ($total listed, $pending not finished)"
  sleep "$poll_s"
done
