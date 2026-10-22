#!/usr/bin/env bash
# Runs one VS Code test label under xvfb for CI (bug 19, CI-4). On the 2-CPU runner VS Code now and
# then freezes at startup ("CodeWindow: detected unresponsive") and exits before any test ran. Only
# that case is relaunched, once: a failed run whose log says "detected unresponsive" and shows no
# test output at all. Any sign that tests ran means the failure is never retried, even when the run
# crashed before its summary: a mocha result line ("N passing" / "N failing"), a passed test (an
# indented "✔"; vscode-test's own "✔ Validated version" lines are not indented), a numbered failure
# ("N) "), or one of our suite titles (they all contain "(integration").
#
# Usage: scripts/vscode-test-ci.sh [label]   (default: stable)
set -uo pipefail

label="${1:-stable}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

run() {
	xvfb-run -a npx vscode-test --label "$label" 2>&1 | tee "$log"
}

testsRan() {
	grep -qE '^[[:space:]]*[0-9]+ (passing|failing)|^[[:space:]]+✔|^[[:space:]]+[0-9]+\) |\(integration' "$log"
}

run
status=$?
if [ "$status" -ne 0 ] && grep -q 'detected unresponsive' "$log" && ! testsRan; then
	echo "::warning::VS Code froze at startup before any test ran (detected unresponsive); relaunching once."
	run
	status=$?
fi
exit "$status"
