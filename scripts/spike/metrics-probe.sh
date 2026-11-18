#!/usr/bin/env bash
# Spike 7.1: probe a Redpanda Cloud cluster's Prometheus endpoint with a running test pipeline.
# The probe itself is scripts/spike/metrics-probe.mjs (Node); see its header for the inputs, the
# steps, the outputs and the redaction.
#
#   bash scripts/spike/metrics-probe.sh             the real run against rpc-vilnius (METRICS_PROBE_CLUSTER)
#   bash scripts/spike/metrics-probe.sh --dry-run   offline: a fake Cloud and a fake Prometheus endpoint
#                                                   on 127.0.0.1; the file refusals, the redaction and
#                                                   the cleanup are checked
#
# Reads the service account from ~/.config/rpcn-spike/credentials.env and the Prometheus access from
# ~/.config/rpcn-spike/metrics.env (PROMETHEUS_USER=, PROMETHEUS_PWD=, PROMETHEUS_URL=; each file
# yours, mode 0600) and never prints, logs or writes them.
# The Prometheus endpoint is only read (GET). The service account creates one vscode-spike-metrics-*
# pipeline, stops it and deletes it before the probe exits. About 9 to 13 minutes.
# Needs Node 22+.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null || { echo "metrics-probe: node is required" >&2; exit 1; }
exec node "$ROOT/scripts/spike/metrics-probe.mjs" "$@"
