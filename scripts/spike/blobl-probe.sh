#!/usr/bin/env bash
# Spike 4.1: probe Bloblang execution routes (blobl server, blobl, run) on every binary flavor.
# The probe itself is scripts/spike/blobl-probe.mjs (Node, for timings and the HTTP route);
# see its header for routes, flavors, outputs and normalisation.
#
#   bash scripts/spike/blobl-probe.sh            20 timing runs per scenario and route
#   BLOBL_PROBE_RUNS=3 bash scripts/spike/blobl-probe.sh   quicker, for a capture-only rerun
#
# Needs the pinned binaries in .cache/ (scripts/spike/fetch-binaries.sh) and Node 18+.
# Nothing is installed, upgraded or modified outside this repo.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null || { echo "blobl-probe: node is required" >&2; exit 1; }
exec node "$ROOT/scripts/spike/blobl-probe.mjs"
