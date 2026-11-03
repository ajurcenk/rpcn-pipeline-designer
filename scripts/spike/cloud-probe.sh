#!/usr/bin/env bash
# Spike 5.1: probe the Redpanda Cloud Control Plane and Data Plane APIs on a real cluster.
# The probe itself is scripts/spike/cloud-probe.mjs (Node, for HTTP and timings); see its header
# for inputs, the steps, outputs and redaction.
#
#   bash scripts/spike/cloud-probe.sh             the real run against rpc-vilnius (CLOUD_PROBE_CLUSTER)
#   bash scripts/spike/cloud-probe.sh --dry-run   offline: a fake Cloud, redaction and cleanup checks
#
# Reads the service account from ~/.config/rpcn-spike/credentials.env (yours, mode 0600) and
# never prints, logs or writes it or the token. Creates only vscode-spike-* pipelines and a
# VSCODE_SPIKE_* secret on the probed cluster and deletes them before it exits.
# Needs Node 18+. Nothing is installed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null || { echo "cloud-probe: node is required" >&2; exit 1; }
exec node "$ROOT/scripts/spike/cloud-probe.mjs" "$@"
