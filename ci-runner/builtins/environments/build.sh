#!/usr/bin/env bash
# The `env:` environments: sets of Wasmer packages (webc) that a job's `run:`
# script executes in. bash runs as a WASIX program and spawns every other
# command from the same set of packages, all inside the one isolate.
#
#   env:bash       bash, coreutils, sed, grep and findutils
#   env:bash-node  the same plus Edge.js (node, npm and pnpm)
#
# Edge.js's WASIX package carries no JavaScript engine of its own; it
# imports N-API from the host, and the runner provides it with V8 through
# wasmer-napi (the runtime crate's `node` feature).
#
# Packages are pinned by content hash. The Wasmer CDN names each webc file
# by its sha256, and this script checks the download against that name, so a
# changed package cannot slip in under an old pin. The runner never contacts
# the Wasmer registry: `iwci publish` copies these into R2.
#
# Edge.js is the one package not taken from the CDN. `edgejs/build.sh`
# builds Wasmer's 0.2.5 from source on a C library without the race behind
# #937, which no Wasmer release has yet; its result is pinned here by hash
# like the others, so a build that comes out different fails.
#
#   environments/build.sh              both
#   environments/build.sh bash         just this one (any host)
#   environments/build.sh bash-node    needs the Edge.js build: x86_64 Linux,
#                                      or its webc already in dist/package/
#
# Needs: curl, shasum; bash-node also what edgejs/build.sh needs.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

# name version sha256 (the CDN file name)
BASH_PKG="wasmer/bash 1.0.25 059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1"
COREUTILS_PKG="wasmer/coreutils 1.0.27 35028c4e6b9fa8cccdffdcab2007d1df3af31b3f2b22fb890d022d7ae723bbd3"
SED_PKG="wasmer/sed 4.9.0 3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393"
GREP_PKG="wasmer/grep 3.12.0 42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca"
FINDUTILS_PKG="wasmer/findutils 0.10.1 4d775bd4d37f26e043a2c54e220c554a67bbe349000930f87c6bc81e4a91c1fb"
# Built by edgejs/build.sh, which names the version; the hash is its output's.
EDGEJS_PKG="wasmer/edgejs 0.2.5-iwci.1 11b3cd900c5acc3ec2b432d82377e4af7f559910e6241335255199c4b6bb5694"

fetch() {
  local dir="$1" name="$2" version="$3" sha="$4"
  local file="$dir/${name//\//-}-$version.webc"
  if [[ "$name" == wasmer/edgejs ]]; then
    # Ours: built here unless a build (or CI's cache of one) is in place.
    local built="$dist/package/edgejs/$version/edgejs.webc"
    [[ -f "$built" ]] || bash "$here/environments/edgejs/build.sh" >&2
    cp "$built" "$file"
  else
    curl -fsSL --retry 3 -o "$file" "https://cdn.wasmer.io/webcimages/$sha.webc"
  fi
  local actual
  actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  if [[ "$actual" != "$sha" ]]; then
    echo "error: $name@$version hashed to $actual, expected $sha" >&2
    exit 1
  fi
  printf '{ "name": "%s", "version": "%s", "file": "%s" }' "$name" "$version" "$(basename "$file")"
}

# build_env <name> <version> <description> <package lines...>
build_env() {
  local name="$1" version="$2" description="$3"
  shift 3
  local out
  out="$(out_dir environment "$name" "$version")"
  local packages=()
  for pkg in "$@"; do
    # shellcheck disable=SC2086
    packages+=("$(fetch "$out" $pkg)")
  done
  local joined
  joined="$(IFS=,; printf '%s' "${packages[*]}")"
  cat >"$out/build.json" <<JSON
{
  "kind": "environment",
  "name": "$name",
  "version": "$version",
  "entry": "bash",
  "packages": [$joined],
  "description": "$description"
}
JSON
  echo "built $out"
}

TOOLS=("$BASH_PKG" "$COREUTILS_PKG" "$SED_PKG" "$GREP_PKG" "$FINDUTILS_PKG")
if [[ $# -eq 0 ]]; then
  set -- bash bash-node
fi
for env in "$@"; do
  case "$env" in
    bash)
      build_env bash 5.1.16 "GNU bash 5.1 with coreutils, sed, grep and findutils" "${TOOLS[@]}"
      ;;
    bash-node)
      # 24.0.1: Edge.js rebuilt on a C library without the #937 race.
      build_env bash-node 24.0.1 "GNU bash 5.1, coreutils, sed, grep, findutils and Edge.js (Node 24 compatible, npm and pnpm)" \
        "${TOOLS[@]}" "$EDGEJS_PKG"
      ;;
    *)
      echo "error: no environment \`$env\`; know bash and bash-node" >&2
      exit 2
      ;;
  esac
done
