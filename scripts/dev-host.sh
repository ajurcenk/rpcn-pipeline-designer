#!/usr/bin/env bash
# Start a VS Code window with this extension loaded from source, for manual checks.
#
#   scripts/dev-host.sh [folder] [file...]
#
# The window gets its own profile and extensions folder under the git-ignored `.dev-host/`
# in the repository (not under /tmp, which is cleaned and has lost test files before), so
# settings, the cached schema and the files you create survive between runs:
#
#   .dev-host/user/        user data (settings, globalStorage, logs)
#   .dev-host/extensions/  YAML by Red Hat 1.24.0 (the extensionDependency) only
#   .dev-host/workspace/   the folder opened when none is given
#
# The bundle is rebuilt first. A window already started by this script with the same profile
# is closed, so running it again restarts the window with the new build. Red Hat YAML is
# copied from `.vscode-test/` (written by `npm test`) or, failing that, installed from the
# Marketplace. Your own VS Code profile and extensions are not touched. `CODE` overrides
# the VS Code executable (default: `code` on PATH).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/.dev-host"
USER_DIR="$BASE/user"
EXT_DIR="$BASE/extensions"
RED_HAT=redhat.vscode-yaml-1.24.0
CODE="${CODE:-code}"

folder="${1:-$BASE/workspace}"
[ $# -gt 0 ] && shift
mkdir -p "$USER_DIR" "$EXT_DIR" "$folder"

if [ ! -d "$EXT_DIR/$RED_HAT" ]; then
  if [ -d "$ROOT/.vscode-test/extensions/$RED_HAT" ]; then
    cp -r "$ROOT/.vscode-test/extensions/$RED_HAT" "$EXT_DIR/"
  else
    "$CODE" --extensions-dir "$EXT_DIR" --install-extension redhat.vscode-yaml@1.24.0
  fi
fi

(cd "$ROOT" && node esbuild.js)

if pkill -f -- "--user-data-dir $USER_DIR" 2>/dev/null; then
  sleep 2
fi

nohup "$CODE" --new-window --user-data-dir "$USER_DIR" --extensions-dir "$EXT_DIR" \
  --extensionDevelopmentPath="$ROOT" "$folder" "$@" > "$BASE/code.log" 2>&1 &
echo "Started VS Code on $folder (profile $USER_DIR, log $BASE/code.log)."
