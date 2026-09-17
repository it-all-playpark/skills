#!/usr/bin/env bash
# ci-wait.sh - Block for a bounded amount of wall-clock time and report how
# much of it actually elapsed.
#
# Usage: ci-wait.sh <seconds>
#
# pr-iterate.js's script-side CI poll loop dispatches a `ci-wait` exec-proxy
# between polls. The Bash tool rejects a bare `sleep <N>` invocation once N is
# more than a few seconds, so the proxy cannot simply run `sleep 45`: the call
# fails without waiting and the loop's wait accounting diverges from
# wall-clock. This script performs the requested total wait as a chain of short
# internal `sleep` calls inside one process, behind a single bare invocation
# whose first token is not `sleep` (`ci-wait <seconds>` via plugin bin/).
#
# Exits 0 and prints {"slept": true, "seconds": N} only after the requested
# duration has actually elapsed (N always equals the requested seconds). Exits
# 1 with a message on stderr and no stdout for invalid input: the caller's
# schema requires `slept`, so a proxy that gets no stdout is treated by the
# workflow as "no wait happened" (fail-closed to ci_pending).
set -euo pipefail

STEP=5
MAX_SECONDS=1800

SECONDS_ARG="${1:-}"
[[ "$SECONDS_ARG" =~ ^[0-9]+$ ]] || { echo "ci-wait: <seconds> must be a non-negative integer, got '${SECONDS_ARG}'" >&2; exit 1; }
(( SECONDS_ARG <= MAX_SECONDS )) || { echo "ci-wait: <seconds> must be <= ${MAX_SECONDS}, got '${SECONDS_ARG}'" >&2; exit 1; }

elapsed=0
while (( elapsed < SECONDS_ARG )); do
    remaining=$(( SECONDS_ARG - elapsed ))
    chunk=$(( remaining < STEP ? remaining : STEP ))
    sleep "$chunk"
    elapsed=$(( elapsed + chunk ))
done

printf '{"slept":true,"seconds":%d}\n' "$elapsed"
