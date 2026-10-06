#!/usr/bin/env bash
# Spike 1.1: run the fixed CLI command matrix against every binary flavor and record raw evidence.
#
# Flavors:
#   standalone-4.100.0, standalone-4.112.0  binaries from scripts/spike/fetch-binaries.sh (.cache/)
#   rpk-4.112.0                             the user's installed `rpk connect`, used read-only; skipped
#                                           unless its managed binary already exists and reports 4.112.0;
#                                           when skipped, existing rpk captures are left untouched
#
# Outputs (all re-generated on every run, so a second run yields identical files):
#   <findings>/captures/<flavor>/<scenario>.{stdout,stderr,exit}
#   <findings>/captures/diff-*.txt, schema-*.txt, rpk-binary-identity.txt
#   test/fixtures/schema/jsonschema-<ver>.json      (standalone flavors)
#   test/corpus/<name>.lint/<ver>.txt               (standalone flavors)
#
# Normalisation applied to captured text so reruns are byte-identical:
#   - the repo root path is replaced with <ROOT>
#   - logfmt `time="..."` values become time="<TS>"
#   - Redpanda license metadata (expires_at, license_org) is redacted (depends on the host's
#     /etc/redpanda/redpanda.license, not on the binary)
#   - `run` scenario stderr and `lint-multi-verbose` output are sorted (lines are emitted
#     concurrently and race)
# Every child gets NO_COLOR=1. Nothing is installed, upgraded or modified outside this repo.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$ROOT/.cache/redpanda-connect"
FINDINGS="$ROOT/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings"
CAPS="$FINDINGS/captures"
FIX="$ROOT/test/corpus/fixtures"
CORPUS="$ROOT/test/corpus"
SCHEMA_OUT="$ROOT/test/fixtures/schema"
VERSIONS=(4.100.0 4.112.0)
RPK_VERSION=4.112.0
RPK_MANAGED="$HOME/.local/bin/.rpk.managed-connect"
TIMEOUT=60      # hard cap for any single non-run command (seconds)
STOP_AFTER=2    # seconds a run-stop child runs before SIGINT
STOP_GRACE=10   # seconds to wait for exit after SIGINT before SIGKILL

export NO_COLOR=1

die() { echo "run-matrix: $*" >&2; exit 1; }
# diff exits 1 when inputs differ (expected) and 2 on trouble
diffok() { diff "$@"; (( $? <= 1 )); }
command -v jq >/dev/null || die "jq is required"

for v in "${VERSIONS[@]}"; do
  [[ -x "$CACHE/$v/redpanda-connect" ]] || die "missing $CACHE/$v/redpanda-connect; run scripts/spike/fetch-binaries.sh"
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

normalize() { # <file> [sort]
  local f="$1" tmp
  tmp="$(mktemp)"
  sed -E \
    -e "s#${ROOT}#<ROOT>#g" \
    -e 's/time="[^"]*"/time="<TS>"/g' \
    -e 's/expires_at="[^"]*"/expires_at="<REDACTED>"/g' \
    -e 's/license_org=("[^"]*"|[^ ]*)/license_org=<REDACTED>/g' \
    "$f" >"$tmp" || die "normalize failed: $f"
  if [[ "${2:-}" == sort ]]; then LC_ALL=C sort "$tmp" >"$f"; else cat "$tmp" >"$f"; fi || die "normalize failed: $f"
  rm -f "$tmp"
}

# cap <outdir> <scenario> <cmd...>   (runs in $FIX, stdin from /dev/null)
cap() {
  local out="$1" sc="$2"; shift 2
  (cd "$FIX" && timeout "$TIMEOUT" "$@" </dev/null >"$out/$sc.stdout" 2>"$out/$sc.stderr")
  echo $? >"$out/$sc.exit"
  normalize "$out/$sc.stdout"; normalize "$out/$sc.stderr"
}

# cap_stdin <outdir> <scenario> <stdin-file> <cmd...>
cap_stdin() {
  local out="$1" sc="$2" in="$3"; shift 3
  (cd "$FIX" && timeout "$TIMEOUT" "$@" <"$in" >"$out/$sc.stdout" 2>"$out/$sc.stderr")
  echo $? >"$out/$sc.exit"
  normalize "$out/$sc.stdout"; normalize "$out/$sc.stderr"
}

# cap_run <outdir> <scenario> <cmd...>   a `run` that terminates on its own; stderr sorted
cap_run() {
  local out="$1" sc="$2"; shift 2
  (cd "$FIX" && timeout "$TIMEOUT" "$@" </dev/null >"$out/$sc.stdout" 2>"$out/$sc.stderr")
  echo $? >"$out/$sc.exit"
  normalize "$out/$sc.stdout"; normalize "$out/$sc.stderr" sort
}

# cap_stop <outdir> <scenario> <cmd...>  run, SIGINT after STOP_AFTER s, record exit + whether it stopped in time
cap_stop() {
  local out="$1" sc="$2"; shift 2
  local pid ec waited=0 stopped=yes
  (cd "$FIX" && exec "$@" </dev/null >"$out/$sc.stdout" 2>"$out/$sc.stderr") &
  pid=$!
  sleep "$STOP_AFTER"
  kill -INT "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= STOP_GRACE * 10 )); then stopped=no; kill -KILL "$pid" 2>/dev/null; break; fi
    sleep 0.1; waited=$((waited + 1))
  done
  wait "$pid"; ec=$?
  echo "$ec" >"$out/$sc.exit"
  printf 'signal=SIGINT after=%ss exited_within_%ss=%s\n' "$STOP_AFTER" "$STOP_GRACE" "$stopped" >"$out/$sc.timing"
  normalize "$out/$sc.stdout"; normalize "$out/$sc.stderr" sort
}

run_flavor() { # <flavor> <cmd...>   cmd is the binary invocation prefix
  local flavor="$1"; shift
  local out="$CAPS/$flavor"
  rm -rf "$out"; mkdir -p "$out"
  echo "[$flavor] running matrix"

  # Version and CLI surface (parity)
  cap "$out" version          "$@" --version
  cap "$out" help-root        "$@" --help
  cap "$out" help-lint        "$@" lint --help
  cap "$out" help-run         "$@" run --help
  cap "$out" help-list        "$@" list --help

  # Lint: clean and error paths
  cap "$out" lint-clean                 "$@" lint clean.yaml
  cap "$out" lint-invalid-field         "$@" lint invalid_field.yaml
  cap "$out" lint-nested-invalid-field  "$@" lint nested_invalid_field.yaml
  cap "$out" lint-missing-required      "$@" lint missing_required.yaml
  cap "$out" lint-missing-file          "$@" lint does_not_exist.yaml
  cap "$out" lint-yaml-syntax           "$@" lint yaml_syntax_error.yaml
  cap "$out" lint-absolute-path         "$@" lint "$FIX/invalid_field.yaml"
  cap "$out" lint-multi-verbose         "$@" lint --verbose clean.yaml invalid_field.yaml
  # files are linted concurrently, so the per-file OK/FAILED lines race: sort them
  normalize "$out/lint-multi-verbose.stdout" sort; normalize "$out/lint-multi-verbose.stderr" sort
  cap "$out" lint-no-paths              "$@" lint
  cap_stdin "$out" lint-stdin invalid_field.yaml "$@" lint -

  # Env vars
  cap "$out" env-no-flag       "$@" lint env_no_default.yaml
  cap "$out" env-skip-check    "$@" lint --skip-env-var-check env_no_default.yaml
  cap "$out" env-dotenv        "$@" lint -e spike.env env_no_default.yaml
  cap "$out" env-with-default  "$@" lint env_with_default.yaml
  cap "$out" env-plus-field-error  "$@" lint env_plus_field_error.yaml

  # Deprecated
  cap "$out" deprecated-no-flag  "$@" lint deprecated.yaml
  cap "$out" deprecated-flag     "$@" lint --deprecated deprecated.yaml

  # Resources
  cap     "$out" resources-lint-no-flag    "$@" lint uses_resource.yaml
  cap     "$out" resources-lint-with-flag  "$@" lint -r spike_resources.yaml uses_resource.yaml
  cap_run "$out" resources-run-no-flag     "$@" run uses_resource.yaml
  cap_run "$out" resources-run-with-flag   "$@" run -r spike_resources.yaml uses_resource.yaml

  # Run refuses a config with lint errors
  cap_run "$out" run-lint-error  "$@" run invalid_field.yaml

  # Run + Stop (SIGINT)
  cap_stop "$out" run-stop  "$@" run run_generate.yaml

  # Schema: full output is too large for a capture; record size, hash and shape here
  local tmp; tmp="$(mktemp)"
  (cd "$FIX" && timeout "$TIMEOUT" "$@" list --format jsonschema </dev/null >"$tmp" 2>"$out/schema.stderr")
  echo $? >"$out/schema.exit"
  normalize "$out/schema.stderr"
  jq -e 'type == "object"' "$tmp" >/dev/null || die "[$flavor] list --format jsonschema did not return a JSON object"
  local bytes sha keys hasschema defs props iskeys
  bytes="$(wc -c <"$tmp" | tr -d ' ')" || die "[$flavor] wc failed"
  sha="$(sha256_of "$tmp")" || die "[$flavor] sha256 failed"
  keys="$(jq -c 'keys' "$tmp")" || die "[$flavor] jq failed"
  hasschema="$(jq 'has("$schema")' "$tmp")" || die "[$flavor] jq failed"
  defs="$(jq -c '.definitions | keys' "$tmp")" || die "[$flavor] jq failed"
  props="$(jq -c '.properties | keys' "$tmp")" || die "[$flavor] jq failed"
  iskeys="$(jq -c '[paths | .[-1] | select(type == "string" and startswith("is_"))] | unique' "$tmp")" || die "[$flavor] jq failed"
  printf '%s\n' "bytes=$bytes" "sha256=$sha" "top_level_keys=$keys" "has_\$schema=$hasschema" \
    "definitions=$defs" "properties=$props" "custom_is_keys=$iskeys" >"$out/schema.stdout" || die "[$flavor] write failed"
  SCHEMA_TMP="$tmp"

  # CUE schema: summary only (field docs are carried as // comments)
  local cue; cue="$(mktemp)"
  (cd "$FIX" && timeout "$TIMEOUT" "$@" list --format cue </dev/null >"$cue" 2>"$out/schema-cue.stderr")
  echo $? >"$out/schema-cue.exit"
  normalize "$out/schema-cue.stderr"
  [[ -s "$cue" ]] || die "[$flavor] list --format cue returned nothing"
  local cbytes ccomments csample
  cbytes="$(wc -c <"$cue" | tr -d ' ')" || die "[$flavor] wc failed"
  ccomments="$(grep -cE '^[[:space:]]*//' "$cue")" || die "[$flavor] no // comment lines in cue output"
  csample="$(grep -m3 -E '^[[:space:]]*//' "$cue" | sed -E 's/^[[:space:]]+//')" || die "[$flavor] grep failed"
  { printf '%s\n' "bytes=$cbytes" "comment_lines=$ccomments" "sample_comments:"; printf '%s\n' "$csample"; } \
    >"$out/schema-cue.stdout" || die "[$flavor] write failed"
  rm -f "$cue"

  # Bloblang functions metadata: summary only
  local bf; bf="$(mktemp)"
  (cd "$FIX" && timeout "$TIMEOUT" "$@" list --format jsonschema bloblang-functions </dev/null >"$bf" 2>"$out/bloblang-functions.stderr")
  echo $? >"$out/bloblang-functions.exit"
  normalize "$out/bloblang-functions.stderr"
  jq -r '.["bloblang-functions"] as $f
    | "top_level_keys=\(keys | tojson)",
      "entries=\($f | length)",
      "with_description=\([$f[] | select((.description // "") != "")] | length)",
      "with_examples=\([$f[] | select((.examples // []) | length > 0)] | length)"' "$bf" \
    >"$out/bloblang-functions.stdout" || die "[$flavor] list --format jsonschema bloblang-functions: unexpected output"
  rm -f "$bf"
}

# Dotted field paths (category.component.field...) declared under any `properties` object
field_paths() {
  jq -r '[paths(objects) | select(.[-2] == "properties")
    | map(select(type == "string" and . != "properties" and . != "allOf" and . != "anyOf"
                 and . != "items" and . != "definitions")) | join(".")] | unique[]' "$1"
}

# Per-category component names in a schema (definitions.<cat>.allOf[0].anyOf[].properties keys)
components() {
  jq -r '.definitions | to_entries[] | .key as $c
    | (.value.allOf[0].anyOf // [])[] | (.properties // {}) | keys[] | "\($c)\t\(.)"' "$1" | LC_ALL=C sort
}

mkdir -p "$CAPS" "$SCHEMA_OUT"

# --- standalone flavors ---
for v in "${VERSIONS[@]}"; do
  run_flavor "standalone-$v" "$CACHE/$v/redpanda-connect"
  mv "$SCHEMA_TMP" "$SCHEMA_OUT/jsonschema-$v.json" || die "mv schema $v failed"
  chmod 644 "$SCHEMA_OUT/jsonschema-$v.json" || die "chmod schema $v failed"

  echo "[standalone-$v] linting corpus"
  for f in "$CORPUS"/*.yaml; do
    name="$(basename "$f" .yaml)"
    mkdir -p "$CORPUS/$name.lint" || die "mkdir $name.lint failed"
    o="$CORPUS/$name.lint/$v.txt"
    err="$(cd "$CORPUS" && timeout "$TIMEOUT" "$CACHE/$v/redpanda-connect" lint --skip-env-var-check "$name.yaml" 2>&1 >/dev/null)"
    ec=$?
    (( ec <= 1 )) || die "[standalone-$v] lint of corpus $name.yaml failed unexpectedly (exit $ec)"
    {
      echo "# redpanda-connect $v: lint --skip-env-var-check $name.yaml (cwd test/corpus, NO_COLOR=1)"
      echo "# exit: $ec"
      if [[ -n "$err" ]]; then printf '%s\n' "$err"; fi
    } >"$o" || die "write $o failed"
    normalize "$o"
  done
done

# --- rpk flavor (read-only) ---
if command -v rpk >/dev/null 2>&1 && [[ -x "$RPK_MANAGED" ]] \
   && "$RPK_MANAGED" --version 2>/dev/null | grep -qx "Version: $RPK_VERSION"; then
  run_flavor "rpk-$RPK_VERSION" rpk connect
  rpk_schema="$SCHEMA_TMP"
  {
    echo "rpk_version=$(rpk version 2>/dev/null | head -1)"
    echo "managed_binary=\$HOME/.local/bin/.rpk.managed-connect"
    echo "managed_sha256=$(sha256_of "$RPK_MANAGED")"
    echo "standalone_${RPK_VERSION}_sha256=$(sha256_of "$CACHE/$RPK_VERSION/redpanda-connect")"
    if cmp -s "$RPK_MANAGED" "$CACHE/$RPK_VERSION/redpanda-connect"; then echo "identical=yes"; else echo "identical=no"; fi
    if cmp -s "$rpk_schema" "$SCHEMA_OUT/jsonschema-$RPK_VERSION.json"; then echo "schema_identical=yes"; else echo "schema_identical=no"; fi
  } >"$CAPS/rpk-binary-identity.txt" || die "write rpk-binary-identity.txt failed"
  rm -f "$rpk_schema"
else
  RPK_SKIPPED=1
  echo "[rpk-$RPK_VERSION] skipped: rpk or its managed connect $RPK_VERSION binary not present (nothing installed; existing rpk captures left untouched)"
fi

# --- diffs ---
echo "[diff] writing diffs"
(cd "$CAPS" && diffok -r "standalone-4.100.0" "standalone-4.112.0") >"$CAPS/diff-standalone-4.100.0-vs-standalone-4.112.0.txt" \
  || die "diff of standalone captures failed"
if [[ -z "${RPK_SKIPPED:-}" ]]; then
  (cd "$CAPS" && diffok -r "standalone-$RPK_VERSION" "rpk-$RPK_VERSION") >"$CAPS/diff-standalone-$RPK_VERSION-vs-rpk-$RPK_VERSION.txt" \
    || die "diff of rpk captures failed"
fi

a="$SCHEMA_OUT/jsonschema-4.100.0.json"; b="$SCHEMA_OUT/jsonschema-4.112.0.json"
for s in "$a" "$b"; do
  components "$s" >/dev/null || die "components extraction failed: $s"
  field_paths "$s" >/dev/null || die "field path extraction failed: $s"
done
{
  echo "# Components per category: lines starting '<' only in 4.100.0, '>' only in 4.112.0"
  diffok <(components "$a") <(components "$b") || die "schema diff failed"
  echo
  echo "# Component counts per category (4.100.0 | 4.112.0)"
  join -t $'\t' <(components "$a" | cut -f1 | uniq -c | awk '{print $2"\t"$1}') \
                <(components "$b" | cut -f1 | uniq -c | awk '{print $2"\t"$1}')
  echo
  echo "# Field paths: '<' only in 4.100.0, '>' only in 4.112.0"
  diffok <(field_paths "$a") <(field_paths "$b") || die "schema diff failed"
  echo
  echo "# Top-level properties diff"
  diffok <(jq -r '.properties | keys[]' "$a") <(jq -r '.properties | keys[]' "$b") || die "schema diff failed"
  echo
  echo "# Deprecated field paths (count): 4.100.0=$(jq '[paths(objects and .is_deprecated == true)] | length' "$a") 4.112.0=$(jq '[paths(objects and .is_deprecated == true)] | length' "$b")"
} >"$CAPS/schema-diff-4.100.0-vs-4.112.0.txt" || die "schema diff failed"

echo "done: captures in ${CAPS#"$ROOT"/}"
