#!/usr/bin/env bash
# check-lgtm.sh - Check if review file contains LGTM
# Usage: check-lgtm.sh <review-file>
# Exit: 0 if LGTM found, 1 otherwise

set -euo pipefail

REVIEW_FILE="${1:-/tmp/review.md}"

if [[ ! -f "$REVIEW_FILE" ]]; then
    echo "Review file not found: $REVIEW_FILE" >&2
    exit 1
fi

if grep -qi "\bLGTM\b" "$REVIEW_FILE"; then
    echo "LGTM"
    exit 0
else
    echo "CHANGES_REQUESTED"
    exit 1
fi
