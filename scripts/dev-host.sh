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
if [ -e "$folder" ] && [ ! -d "$folder" ]; then
  echo "dev-host: $folder is not a folder; pass a folder first, then files: scripts/dev-host.sh <folder> <file...>" >&2
  exit 2
fi
mkdir -p "$USER_DIR" "$EXT_DIR" "$folder"

if [ ! -d "$EXT_DIR/$RED_HAT" ]; then
  if [ -d "$ROOT/.vscode-test/extensions/$RED_HAT" ]; then
    cp -r "$ROOT/.vscode-test/extensions/$RED_HAT" "$EXT_DIR/"
  else
    "$CODE" --extensions-dir "$EXT_DIR" --install-extension redhat.vscode-yaml@1.24.0
  fi
fi

(cd "$ROOT" && node esbuild.js)

# Close a window from an earlier run (matched by its profile folder, regex-escaped) and wait
# until it is gone, so the new window does not hand off to the dying instance.
pattern="--user-data-dir $(printf '%s' "$USER_DIR" | sed 's/[][\\.*^$+?(){}|]/\\&/g')"
if pkill -f -- "$pattern" 2>/dev/null; then
  for _ in $(seq 1 50); do
    pgrep -f -- "$pattern" > /dev/null || break
    sleep 0.2
  done
  if pgrep -f -- "$pattern" > /dev/null; then
    echo "dev-host: the previous window did not exit within 10 s; close it and run again." >&2
    exit 1
  fi
fi

nohup "$CODE" --new-window --user-data-dir "$USER_DIR" --extensions-dir "$EXT_DIR" \
  --extensionDevelopmentPath="$ROOT" "$folder" "$@" > "$BASE/code.log" 2>&1 &
echo "Started VS Code on $folder (profile $USER_DIR, log $BASE/code.log)."
