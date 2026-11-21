#!/usr/bin/env bash
# Regenerates the lockfiles and the recorded layouts in this directory with a
# real Bun (1.4.4 wrote the ones committed, on darwin-arm64). Run it from this
# directory with BUN pointing at the binary. The tests never run it and never
# reach the network: they read what it wrote.
set -euo pipefail
BUN="${BUN:-bun}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export BUN_INSTALL_CACHE_DIR="$work/cache"

# Every symlink (L) and every installed package directory (P) under the
# project, without the `.bin` directories, which the tests check on their
# own (none of these packages has a command).
layout() {
  (
    cd "$1"
    find . -path '*/.bin' -prune -o -type l -print | LC_ALL=C sort | while read -r link; do
      echo "L ${link#./} -> $(readlink "$link")"
    done
    find . -path '*/.bin' -prune -o -type f -name package.json -path '*/node_modules/*' -print |
      LC_ALL=C sort | while read -r manifest; do
      dir="$(dirname "${manifest#./}")"
      rest="${dir##*node_modules/}"
      case "$rest" in
      @*/*/*) ;;
      @*/*) echo "P $dir" ;;
      */*) ;;
      *) echo "P $dir" ;;
      esac
    done
  )
}

install() { # <fixture> <layout file> [bun install flags]
  local fixture="$1" out="$2"
  shift 2
  rm -rf "$work/project"
  cp -R "$here/$fixture" "$work/project"
  rm -f "$work/project"/layout-*.txt
  (cd "$work/project" && "$BUN" install "$@" >/dev/null 2>&1)
  cp "$work/project/bun.lock" "$here/$fixture/bun.lock"
  layout "$work/project" >"$here/$fixture/$out"
}

for fixture in single workspace peers features; do
  rm -f "$here/$fixture/bun.lock"
done
install single layout-hoisted.txt
install workspace layout-isolated.txt
install workspace layout-hoisted.txt --linker hoisted
install peers layout-isolated.txt
install features layout-isolated.txt

# `bun patch` writes the patch and records it in package.json and bun.lock.
rm -rf "$work/project"
cp -R "$here/features" "$work/project"
rm -f "$work/project"/layout-*.txt
(
  cd "$work/project"
  "$BUN" install >/dev/null 2>&1
  "$BUN" patch is-odd >/dev/null 2>&1
  echo "module.exports.patched = true;" >>node_modules/is-odd/index.js
  "$BUN" patch --commit node_modules/is-odd >/dev/null 2>&1
)
cp "$work/project/bun.lock" "$work/project/package.json" "$here/features/"
mkdir -p "$here/features/patches"
cp "$work/project/patches/"* "$here/features/patches/"
layout "$work/project" >"$here/features/layout-isolated.txt"
