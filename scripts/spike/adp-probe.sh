#!/usr/bin/env bash
# Spike 65: probe the Redpanda ADP LLM proxy's Anthropic Messages API contract with plain HTTP.
# The probe itself is scripts/spike/adp-probe.mjs (Node); see its header for the inputs, the
# calls, the outputs and the redaction.
#
#   bash scripts/spike/adp-probe.sh             the real run against ADP (at most 10 small calls;
#                                               run it only when the user says so)
#   bash scripts/spike/adp-probe.sh --dry-run   offline: a fake Messages API on 127.0.0.1; the
#                                               file refusals, the redaction and the recorders
#                                               are checked
#
# Reads the keys ADP_BASE_URL, ADP_API_KEY, ADP_MODEL and ADP_HEADERS from ~/.config/rpcn-spike/adp.env
# (yours, mode 0600) and never prints, logs or writes the key, the host or the header values.
# Needs Node 22+.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null || { echo "adp-probe: node is required" >&2; exit 1; }
exec node "$ROOT/scripts/spike/adp-probe.mjs" "$@"
