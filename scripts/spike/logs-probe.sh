#!/usr/bin/env bash
# Spike 6.1: probe reading the `__redpanda.connect.logs` topic of a Redpanda Cloud cluster through
# its Kafka API. The probe itself is scripts/spike/logs-probe.mjs (Node); see its header for the
# inputs, the steps, the outputs and the redaction.
#
#   bash scripts/spike/logs-probe.sh             the real run against rpc-vilnius (LOGS_PROBE_CLUSTER)
#   bash scripts/spike/logs-probe.sh --dry-run   offline: a fake Cloud, a local fake broker for the
#                                                raw requests and fake clients; the credentials-file
#                                                refusals, the redaction and the cleanup are checked
#
# Reads the service account from ~/.config/rpcn-spike/credentials.env and the Redpanda user from
# ~/.config/rpcn-spike/logs.env (redpanda_user=, repanda_user_pwd=, auth_mechanism=; or username=,
# password=, mechanism=; each yours, mode 0600) and never prints, logs or writes them.
# Kafka is read only: no consumer group, no commit, nothing produced. The service account creates
# one vscode-spike-logs-* pipeline and deletes it before the probe exits.
# The real run installs kafkajs and @platformatic/kafka into .cache/logs-probe/ (git-ignored) and
# bundles each with the repository's esbuild; the extension's package.json is not touched.
# Needs Node 22+.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null || { echo "logs-probe: node is required" >&2; exit 1; }
exec node "$ROOT/scripts/spike/logs-probe.mjs" "$@"
