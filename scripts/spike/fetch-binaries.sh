#!/usr/bin/env bash
# Spike 1.1: fetch pinned standalone Redpanda Connect binaries into a git-ignored cache.
#
#   .cache/redpanda-connect/<ver>/<asset>.tar.gz     release archive (kept for re-verification)
#   .cache/redpanda-connect/<ver>/<asset>.sha256     published checksum (bare hash)
#   .cache/redpanda-connect/<ver>/redpanda-connect   extracted binary
#
# Idempotent: an archive already in the cache whose sha256 matches is not downloaded
# again, and an already extracted binary is not re-extracted while its sha256 equals that of
# the verified archive's `redpanda-connect`; a replaced one is extracted again. Requires an
# authenticated `gh`.
# Never touches the user's installed redpanda-connect, rpk or ~/.local/bin/.rpk.managed-connect.
set -euo pipefail

VERSIONS=(4.100.0 4.112.0)
REPO=redpanda-data/connect

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$ROOT/.cache/redpanda-connect"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 2 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

verified() { # <archive> <sha-file>
  [[ -f "$1" && -f "$2" ]] || return 1
  [[ "$(sha256_of "$1")" == "$(awk '{print $1}' "$2")" ]]
}

for ver in "${VERSIONS[@]}"; do
  dir="$CACHE/$ver"
  asset="redpanda-connect_${ver}_${os}_${arch}.tar.gz"
  mkdir -p "$dir"

  if verified "$dir/$asset" "$dir/$asset.sha256"; then
    echo "[$ver] cached: $asset (sha256 ok)"
  else
    echo "[$ver] downloading $asset"
    rm -f "$dir/$asset" "$dir/$asset.sha256" "$dir/redpanda-connect"
    gh release download "v$ver" -R "$REPO" -D "$dir" -p "$asset" -p "$asset.sha256"
    if ! verified "$dir/$asset" "$dir/$asset.sha256"; then
      echo "[$ver] sha256 mismatch for $asset" >&2
      rm -f "$dir/$asset"
      exit 1
    fi
    echo "[$ver] sha256 ok"
  fi

  # The extracted binary must be the verified archive's: compare with the archive member.
  member="$(tar -xzOf "$dir/$asset" redpanda-connect | sha256_stdin)"
  if [[ -x "$dir/redpanda-connect" && "$(sha256_of "$dir/redpanda-connect")" == "$member" ]]; then
    echo "[$ver] extracted binary matches the archive"
  else
    [[ -e "$dir/redpanda-connect" ]] && echo "[$ver] extracted binary differs from the archive or is not executable: extracting it again"
    rm -f "$dir/redpanda-connect"
    tar -xzf "$dir/$asset" -C "$dir" redpanda-connect
    chmod +x "$dir/redpanda-connect"
    echo "[$ver] extracted"
  fi
done
