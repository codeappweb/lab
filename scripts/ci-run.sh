#!/usr/bin/env bash
# ci-run.sh — run a command; on failure emit key log lines as GitHub Actions
# error annotations so failures are visible on the public run page without
# downloading logs. Never alters the exit code: failure stays failure.
set +e
"$@" > /tmp/ci-run.log 2>&1
rc=$?
cat /tmp/ci-run.log
if [ "$rc" -ne 0 ]; then
  grep -E "Error|error|FAIL|Exception|SyntaxError|TypeError|ReferenceError|at |Cannot" /tmp/ci-run.log \
    | head -25 | sed 's/^/::error title=gate failure::/' || true
fi
exit $rc
