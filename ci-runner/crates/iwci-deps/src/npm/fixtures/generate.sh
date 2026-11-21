#!/usr/bin/env bash
# Regenerates the lockfile, the bundling tarball and the recorded layout in
# this directory with a real npm (11.19.0 wrote the ones committed, on
# darwin-arm64). Run it from anywhere with NPM pointing at npm. No install
# script runs (`--ignore-scripts`), and the tests never run this or reach
# the network: they read what it wrote.
set -euo pipefail
NPM="${NPM:-npm}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export npm_config_cache="$work/cache"
quiet=(--ignore-scripts --no-audit --no-fund --loglevel=error)

# Every symlink (L) and every installed package directory (P) under the
# project, without the `.bin` directories, which the runner leaves out.
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

# withbundle: a package that bundles `inner`, which is on no registry, so
# only its tarball can provide it. `npm pack` gives every entry the same
# time, so the tarball comes out the same each run.
cp -R "$here/withbundle" "$work/withbundle"
mkdir -p "$work/withbundle/node_modules/inner"
printf '{\n  "name": "inner",\n  "version": "1.0.0",\n  "main": "index.js"\n}\n' \
  >"$work/withbundle/node_modules/inner/package.json"
printf 'module.exports = "inner";\n' >"$work/withbundle/node_modules/inner/index.js"
(cd "$work/withbundle" && "$NPM" pack --pack-destination "$here/workspace/vendor" "${quiet[@]}" >/dev/null)

rm -f "$here/workspace/package-lock.json"
cp -R "$here/workspace" "$work/project"
rm -f "$work/project"/layout-*.txt
(cd "$work/project" && "$NPM" install "${quiet[@]}" >/dev/null)
cp "$work/project/package-lock.json" "$here/workspace/package-lock.json"
# What `npm ci` makes of that lockfile.
(cd "$work/project" && rm -rf node_modules && "$NPM" ci "${quiet[@]}" >/dev/null)
layout "$work/project" >"$here/workspace/layout.txt"
# And every command it linked into a `.bin`.
(
  cd "$work/project"
  find . -path '*/.bin/*' -type l -print | LC_ALL=C sort | while read -r link; do
    echo "B ${link#./} -> $(readlink "$link")"
  done
) >"$here/workspace/bins.txt"

# The small registry tarballs the tests unpack for real.
for tarball in is-number/-/is-number-6.0.0.tgz is-number/-/is-number-7.0.0.tgz \
  is-odd/-/is-odd-3.0.1.tgz ms/-/ms-2.1.2.tgz ms/-/ms-2.1.3.tgz; do
  curl -fsSL "https://registry.npmjs.org/$tarball" -o "$here/tarballs/${tarball##*/}"
done
