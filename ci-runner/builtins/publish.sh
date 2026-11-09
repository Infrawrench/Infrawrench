#!/usr/bin/env bash
# Publishes everything the build scripts left in dist/ to the runner pool's
# store (IWCI_R2_ACCOUNT_ID, IWCI_R2_BUCKET, IWCI_R2_ACCESS_KEY_ID,
# IWCI_R2_SECRET_ACCESS_KEY), one directory at a time.
#
# Versions are immutable. A version published before with the same files is
# a no-op. One published with different files (a rebuild that is not byte
# for byte the same, which the nightly builds can produce) is left as it is
# and reported as a warning: the published bytes keep serving, and a real
# change needs a new version in its build script.
#
#   builtins/publish.sh              every directory under dist/
#   builtins/publish.sh <dir>...     just these
#
# IWCI is the `iwci` binary (default: target/debug/iwci).
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dist="${DIST:-$here/../dist}"
IWCI="${IWCI:-$here/../target/debug/iwci}"

for name in IWCI_R2_ACCOUNT_ID IWCI_R2_BUCKET IWCI_R2_ACCESS_KEY_ID IWCI_R2_SECRET_ACCESS_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "publish.sh: $name is not set" >&2
    exit 1
  fi
done

dirs=("$@")
if [[ ${#dirs[@]} -eq 0 ]]; then
  while IFS= read -r manifest; do
    dirs+=("$(dirname -- "$manifest")")
  done < <(find "$dist" -name build.json | sort)
fi
if [[ ${#dirs[@]} -eq 0 ]]; then
  echo "publish.sh: nothing built under $dist" >&2
  exit 1
fi

for dir in "${dirs[@]}"; do
  if out="$("$IWCI" publish "$dir" 2>&1)"; then
    printf '%s\n' "$out"
  elif grep -q "is already published with different content" <<<"$out"; then
    # The annotation GitHub Actions shows on the run; plain text elsewhere.
    echo "::warning title=Not republished::${dir#"$dist"/} is already published with different bytes; bump its version to publish the new build."
  else
    printf '%s\n' "$out" >&2
    exit 1
  fi
done
