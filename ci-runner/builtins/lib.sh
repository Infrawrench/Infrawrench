# shellcheck shell=bash
# Shared by the build scripts. Each script leaves one directory under
# dist/ holding the built files and a build.json that `iwci publish` reads:
# it hashes every file, uploads the blobs to R2 under blobs/sha256/, and
# writes the manifest. Versions are immutable, so republishing a version
# with different bytes is refused.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dist="${DIST:-$here/../dist}"

# out_dir <kind> <name> <version>: a fresh output directory.
out_dir() {
  local dir="$dist/$1/$2/$3"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

# A scratch directory, removed on exit, outside the repository so a source
# checkout never lands in the working tree. Set here rather than returned
# from a function: a trap set inside `$(...)` would fire as soon as that
# subshell ended and delete the directory before it was used.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/iwci-builtin.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
