#!/usr/bin/env bash
# The `env:` environments: sets of Wasmer packages (webc) that a job's `run:`
# script executes in. bash runs as a WASIX program and spawns every other
# command from the same set of packages, all inside the one isolate.
#
#   env:bash       bash, coreutils, sed, grep and findutils
#   env:bash-node  the same plus Edge.js (node, npm and pnpm)
#   env:python     the same as env:bash plus CPython with pip
#
# An environment can also set default environment variables, which a job's
# own `env:` overrides (python's make pip and pytest work here).
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
# builds Wasmer's 0.2.5 from source on a C library without the races behind
# #937 and #967, which no Wasmer release has yet; its result is pinned here
# by hash like the others, so a build that comes out different fails.
#
#   environments/build.sh              all of them
#   environments/build.sh bash         just this one (any host)
#   environments/build.sh python       the same
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
PYTHON_PKG="python/python 3.13.20 a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7"
# python/python's version is Wasmer's, not the interpreter's: 3.13.20 holds
# CPython 3.13.15, which is the environment's version. Its prefix is a Nix
# store path inside the package, where pip puts console scripts (`pytest`).
PYTHON_PREFIX="/nix/store/wf0002v5izqcb7kg59n8cilx58lcp373-python3-static-wasm32-unknown-wasi-3.13.15"
# What `pip install` and pytest need here (README.md, "Python"):
#   PATH  the default plus where pip puts console scripts.
#   _PYTHON_HOST_PLATFORM  the interpreter calls its platform
#     `wasi_0_0_0_wasm32`, under which pip takes none of the `wasix_wasm32`
#     wheels and builds numpy and the like from source, which cannot work.
#   PIP_EXTRA_INDEX_URL  Wasmer's index of wheels built for WASIX (numpy,
#     pandas, pydantic-core, cryptography, lxml, ...), next to PyPI.
#   PIP_PREFER_BINARY  without it pip takes PyPI's newer sdist over the
#     index's wheel of an older release, and fails to build it.
#   PIP_BREAK_SYSTEM_PACKAGES  the interpreter is marked externally managed
#     (it lives in the Nix store); installing into it is what a job wants.
#   PIP_ROOT_USER_ACTION, PIP_DISABLE_PIP_VERSION_CHECK  quiet: a job runs
#     as root, and pip need not ask PyPI for its own newest version.
#   PYTEST_ADDOPTS  pytest's faulthandler plugin fails to start ("Value too
#     large for data type"). pytest adds this to a repository's own
#     `addopts` rather than replacing them.
PYTHON_ENV='"PATH": "/usr/local/bin:/usr/bin:/bin:'"$PYTHON_PREFIX"'/bin",
    "_PYTHON_HOST_PLATFORM": "wasix-wasm32",
    "PIP_EXTRA_INDEX_URL": "https://python-registry.wasix.org/simple/",
    "PIP_PREFER_BINARY": "1",
    "PIP_BREAK_SYSTEM_PACKAGES": "1",
    "PIP_ROOT_USER_ACTION": "ignore",
    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    "PYTEST_ADDOPTS": "-p no:faulthandler"'
# Built by edgejs/build.sh, which names the version; the hash is its output's.
EDGEJS_PKG="wasmer/edgejs 0.2.5-iwci.4 db3d944ce796cfa271eb718634759d6bebffe85b5ad805c7424a77684d831df5"

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

# build_env <name> <version> <description> <env> <package lines...>
# <env> is the manifest's default environment as JSON object members
# (`"KEY": "value", ...`), or empty; a job's own `env:` wins over it.
build_env() {
  local name="$1" version="$2" description="$3" env="$4"
  shift 4
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
  "env": { $env },
  "description": "$description"
}
JSON
  echo "built $out"
}

TOOLS=("$BASH_PKG" "$COREUTILS_PKG" "$SED_PKG" "$GREP_PKG" "$FINDUTILS_PKG")
if [[ $# -eq 0 ]]; then
  set -- bash bash-node python
fi
for env in "$@"; do
  case "$env" in
    bash)
      build_env bash 5.1.16 "GNU bash 5.1 with coreutils, sed, grep and findutils" "" "${TOOLS[@]}"
      ;;
    bash-node)
      # 24.0.1: Edge.js rebuilt on a C library without the #937 race.
      # 24.0.2: and without #967's write into a joined thread's stack.
      # 24.0.3: and a stopped Worker runs none of its queued messages (#938).
      # 24.0.4: and stopping a Worker that is ending frees nothing in use (#938).
      build_env bash-node 24.0.4 "GNU bash 5.1, coreutils, sed, grep, findutils and Edge.js (Node 24 compatible, npm and pnpm)" "" \
        "${TOOLS[@]}" "$EDGEJS_PKG"
      ;;
    python)
      build_env python 3.13.15 "GNU bash 5.1, coreutils, sed, grep, findutils and CPython 3.13.15 with pip" \
        "$PYTHON_ENV" "${TOOLS[@]}" "$PYTHON_PKG"
      ;;
    *)
      echo "error: no environment \`$env\`; know bash, bash-node and python" >&2
      exit 2
      ;;
  esac
done
