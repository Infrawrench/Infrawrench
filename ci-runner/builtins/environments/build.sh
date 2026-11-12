#!/usr/bin/env bash
# The `env:` environments: sets of Wasmer packages (webc) that a job's `run:`
# script executes in. bash runs as a WASIX program and spawns every other
# command from the same set of packages, all inside the one isolate.
#
#   env:bash       bash, coreutils, sed, grep and findutils
#   env:bash-node  the same plus Edge.js (node, npm and pnpm)
#   env:python     the same as env:bash plus CPython with pip
#   env:php        the same as env:bash plus PHP (Wasmer's phpix), Composer
#                  and a `php` that behaves like php-cli (php-cli/build.sh)
#   env:go         the same as env:bash plus a Go toolchain (five minors)
#
# An environment can also set default environment variables, which a job's
# own `env:` overrides (python's make pip and pytest work here, php's put
# php-cli's commands first).
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
# Four packages are not taken from the CDN as they are. `edgejs/build.sh`
# builds Wasmer's Edge.js 0.2.5 from source on a C library without the races
# behind #937 and #967, which no Wasmer release has yet; `bash/build.sh` and
# `sed/build.sh` change the one call in Wasmer's bash 1.0.25 and sed 4.9.0
# that split an argument at its line feeds (#1003, #1022); and
# `php-cli/build.sh` packages env:php's own `php` and Composer. Each result
# is pinned here by hash like the others, so a build that comes out
# different fails.
#
#   environments/build.sh              all of them
#   environments/build.sh bash         just this one (Linux, or macOS on
#                                      arm64: patch-module.sh's Wasmer CLI)
#   environments/build.sh python       the same
#   environments/build.sh php          every PHP version (Linux, x86_64 or
#                                      ARM64, to build php-cli)
#   environments/build.sh go           every Go minor: builds each with
#                                      go/build.sh (Linux, x86_64 or arm64),
#                                      or uses its webcs already in
#                                      dist/package/go/
#   environments/build.sh go@1.25      just that minor
#   environments/build.sh bash-node    needs the Edge.js build: x86_64 Linux,
#                                      or its webc already in dist/package/
#
# Needs: curl, shasum, and what patch-module.sh needs; bash-node and php also
# what edgejs/build.sh and php-cli/build.sh need.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

# name version sha256 (the CDN file name) [our build's version]
# Built by bash/build.sh as 1.0.25-iwci.1; the hash is its output's. The
# package keeps Wasmer's version, because Edge.js and Python depend on
# `wasmer/bash@^1.0.25` and no prerelease satisfies that. Everything that
# caches a package keys it by hash, so the two 1.0.25s never meet.
BASH_PKG="wasmer/bash 1.0.25 d7dd2f6edadae959e6a808e5060f4e0dcdb129dbe4f8b862c8a5c2fec2aa7808 1.0.25-iwci.1"
COREUTILS_PKG="wasmer/coreutils 1.0.27 35028c4e6b9fa8cccdffdcab2007d1df3af31b3f2b22fb890d022d7ae723bbd3"
# Built by sed/build.sh as 4.9.0-iwci.1, keeping Wasmer's version the same
# way.
SED_PKG="wasmer/sed 4.9.0 c7f3db6a65e504328156b688195eff14456412974f0a75d05fb8e5155d545539 4.9.0-iwci.1"
GREP_PKG="wasmer/grep 3.12.0 42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca"
FINDUTILS_PKG="wasmer/findutils 0.10.1 4d775bd4d37f26e043a2c54e220c554a67bbe349000930f87c6bc81e4a91c1fb"
PYTHON_PKG="python/python 3.13.20 a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7"
PHP81_PKG="phpix/phpix-81-64bit 0.3.1 48312c144634ffa5ea1eaef13b48f9b626a947bab6179685ec5196528f81362f"
PHP82_PKG="phpix/phpix-82-64bit 0.3.1 3e05a9e6546757ffee72bc1d19c26b1a62a92dcaadda2a42c36f1fdc2a7a3754"
PHP83_PKG="phpix/phpix-83-64bit 0.3.1 d2ff745903b5c6130662a198d330456daf8cb953438a0d8b8246130a3fb25043"
PHP84_PKG="phpix/phpix-84-64bit 0.3.1 87544a1e1f2aa90d51a8e03f7c488688a13c76e60bf66bd2e24259cd53a9d818"
PHP85_PKG="phpix/phpix-85-64bit 0.3.1 b7e965aad52225c843d0b2540e060f097bd431adcdf228de387c395f435dc074"
SENDMAIL_PKG="sendmail/sendmail 0.1.10 95e52a98e0e684c681c128a07a8031ed284cb5bea71b73a74a44d037a5288d13"
ICU_DATA_PKG="wasmer/icu-data 78.3.0 6e27d8c3828d52fb7ad66afb8438d4c18dde7f5b8dffae7069bc1fd989076c20"
# python/python's version is Wasmer's, not the interpreter's: 3.13.20 holds
# CPython 3.13.15, which named the environment's first version. Its prefix is
# a Nix store path inside the package, where pip puts console scripts
# (`pytest`).
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
# phpix is Wasmer's PHP: libphp from wasix-org/php inside a host of their
# own whose source is not public, and its OpenSSL and curl report
# development versions (3.2.0-dev, 8.4.0-DEV). It needs sendmail (`mail()`)
# and the ICU data (`intl`) beside it. php-cli/build.sh builds the rest
# (a `php` that keeps the working directory, Composer); its hash is its
# output's, as with Edge.js.
PHP_CLI_PKG="iwci/php-cli 1.0.0 83be1308ebb5e9aca02ded9133aec8f6de24c15e763ae0568adff80301f983ea"
# What PHP jobs need here (README.md, "PHP"):
#   PATH  php-cli's `php` and `composer` ahead of phpix's own `php`.
#   COMPOSER_ALLOW_SUPERUSER  a job runs as root, which Composer warns
#     about on every command.
#   COMPOSER_NO_INTERACTION  nobody answers a question in a job, and a job's
#     descriptors all read as terminals (#1008), so Composer would ask.
PHP_ENV='"PATH": "/usr/local/bin:/opt/php-cli/bin:/usr/bin:/bin",
    "COMPOSER_ALLOW_SUPERUSER": "1",
    "COMPOSER_NO_INTERACTION": "1"'
# Built by edgejs/build.sh, which names the version; the hash is its output's.
EDGEJS_PKG="wasmer/edgejs 0.2.5-iwci.5 b05e9d14ebf6d5840653bec7aa9d441037fe1c0d13399de15340c1e020771b01"
# Go, built by go/build.sh <minor> as two packages: the toolchain, and the
# standard library's build cache (together over the store's per-file limit).
# The environment's version is the Go release's.
go_pkgs() {
  case "$1" in
    1.23) echo "1.23.12-iwci.1 44d930abee67f242d273386fb76af0fb66cae73b37bde9e3addd4cff9dd105b0 8de9b4ff060b272b8857d0cef043e46d23ecf481374310eadebfe2cda10b4355" ;;
    1.24) echo "1.24.13-iwci.1 fc66f7a45ce73e9a4246194147bd68b0294a68024f8d15ba44f6ef28d30f563c f953cbc478c9f52f714e3c58c548b01e2f4ed7a48ce758736f9156151e6c154f" ;;
    1.25) echo "1.25.14-iwci.1 748fe2d628d8700db3c8977fddb27bbe14622d3729f5664d23e4f7e73d1f7238 b7a89719757bc0c7d050f13d52d13622124aa1c876149cb4e109b6d108d2623d" ;;
    1.26) echo "1.26.11-iwci.1 0b8375201683a9a00f2e7d9d6593ada7dd10d93b56f3f4da5173d024a6dfb5b8 93147c7f4879f44374f93e414d37ba975d48816c55d28454f7e8583d83bbb767" ;;
    1.27) echo "1.27.4-iwci.1 16f9793e874e82e85cde25d4e569b7df1b27707cfa42d37c29dc62270e362b97 20f2c885e5b89ec967abd98eed137da2460eab3e33b1b2a3da15bbd5b820f2d5" ;;
    *) return 1 ;;
  esac
}
GO_MINORS=(1.23 1.24 1.25 1.26 1.27)
# What the toolchain needs from the job's environment (README.md, "Go"):
#   PATH  the default plus where `go install` puts programs.
#   GOROOT  the toolchain's tree in the package; the wasm `go` cannot find
#     it from where it runs.
#   GOCACHE  where the package's build cache is. Writes go to the job's
#     own copy of it.
#   GOTOOLCHAIN  never download a toolchain: none on the module proxy runs
#     here, and a `go` line newer than the toolchain should say so.
#   SSL_CERT_FILE  the package's CA certificates; Go's wasip1 port looks in
#     no default place.
GO_ENV='"PATH": "/usr/local/bin:/usr/bin:/bin:/root/go/bin",
    "GOROOT": "/go",
    "GOPATH": "/root/go",
    "GOCACHE": "/root/.cache/go-build",
    "GOTOOLCHAIN": "local",
    "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt"'

fetch() {
  local dir="$1" name="$2" version="$3" sha="$4" build="${5:-$3}"
  local file="$dir/${name//\//-}-$version.webc"
  local ours=""
  case "$name" in
    wasmer/bash) ours=bash ;;
    wasmer/sed) ours="sed" ;;
    wasmer/edgejs) ours=edgejs ;;
    iwci/php-cli) ours="php-cli" ;;
  esac
  if [[ -n "$ours" ]]; then
    # Ours: built here unless a build (or CI's cache of one) is in place.
    local built="$dist/package/$ours/$build/$ours.webc"
    [[ -f "$built" ]] || bash "$here/environments/$ours/build.sh" >&2
    cp "$built" "$file"
  elif [[ "$name" == iwci/go* ]]; then
    # Ours too: go/build.sh <minor> makes both of a minor's packages.
    local built="$dist/package/go/$version/${name#iwci/}.webc"
    [[ -f "$built" ]] || bash "$here/environments/go/build.sh" "$(cut -d. -f1-2 <<<"$version")" >&2
    cp "$built" "$file"
  else
    # Once per run: environments share most of their packages.
    local cached="$SCRATCH/cdn/$sha.webc"
    if [[ ! -f "$cached" ]]; then
      mkdir -p "$SCRATCH/cdn"
      curl -fsSL --retry 3 -o "$cached" "https://cdn.wasmer.io/webcimages/$sha.webc"
    fi
    cp "$cached" "$file"
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
  set -- bash bash-node python php go
fi
for env in "$@"; do
  case "$env" in
    bash)
      # 5.1.17: an argument with a line feed in it reaches the program whole
      # (#1003).
      # 5.1.18: and so does a command sed's `e` runs (#1022).
      build_env bash 5.1.18 "GNU bash 5.1 with coreutils, sed, grep and findutils" "" "${TOOLS[@]}"
      ;;
    bash-node)
      # 24.0.1: Edge.js rebuilt on a C library without the #937 race.
      # 24.0.2: and without #967's write into a joined thread's stack.
      # 24.0.3: and a stopped Worker runs none of its queued messages (#938).
      # 24.0.4: and stopping a Worker that is ending frees nothing in use (#938).
      # 24.0.5: and bash passes an argument with a line feed in it whole (#1003).
      # 24.0.6: and so does sed's `e` command (#1022).
      # 24.0.7: and neither does asking a Worker for its heap statistics, CPU
      #         use, a report or its loop's idle time, which now work
      #         (#938, #1006); and `stat`, `chmod` and friends read and set
      #         the runner's file modes (#959).
      build_env bash-node 24.0.7 "GNU bash 5.1, coreutils, sed, grep, findutils and Edge.js (Node 24 compatible, npm and pnpm)" "" \
        "${TOOLS[@]}" "$EDGEJS_PKG"
      ;;
    go | go@*)
      minors=("${GO_MINORS[@]}")
      [[ "$env" == go ]] || minors=("${env#go@}")
      for minor in "${minors[@]}"; do
        if ! pkgs="$(go_pkgs "$minor")"; then
          echo "error: no Go $minor; know ${GO_MINORS[*]}" >&2
          exit 2
        fi
        read -r version go_sha cache_sha <<<"$pkgs"
        build_env go "${version%-iwci.*}" "GNU bash 5.1, coreutils, sed, grep, findutils and Go ${version%-iwci.*} (go, gofmt)" \
          "$GO_ENV" "${TOOLS[@]}" "iwci/go $version $go_sha" "iwci/go-std-cache $version $cache_sha"
      done
      ;;
    python)
      # 3.13.16: bash passes an argument with a line feed in it whole (#1003).
      # 3.13.17: and so does sed's `e` command (#1022).
      build_env python 3.13.17 "GNU bash 5.1, coreutils, sed, grep, findutils and CPython 3.13.15 with pip" \
        "$PYTHON_ENV" "${TOOLS[@]}" "$PYTHON_PKG"
      ;;
    php)
      # phpix 0.3.1 holds PHP 8.1.34, 8.2.35, 8.3.36, 8.4.27 and 8.5.12,
      # which were also the environments' first versions. Each line is the
      # environment's version, then PHP's, then the package.
      # +1 on each: bash passes an argument with a line feed in it whole
      # (#1003).
      # +2: and so does sed's `e` command (#1022).
      for pkg in "8.1.36 8.1.34 $PHP81_PKG" "8.2.37 8.2.35 $PHP82_PKG" "8.3.38 8.3.36 $PHP83_PKG" \
        "8.4.29 8.4.27 $PHP84_PKG" "8.5.14 8.5.12 $PHP85_PKG"; do
        read -r version php package <<<"$pkg"
        build_env php "$version" "GNU bash 5.1, coreutils, sed, grep, findutils, PHP $php (Wasmer's phpix) and Composer" \
          "$PHP_ENV" "${TOOLS[@]}" "$package" "$SENDMAIL_PKG" "$ICU_DATA_PKG" "$PHP_CLI_PKG"
      done
      ;;
    *)
      echo "error: no environment \`$env\`; know bash, bash-node, python, php and go (or go@<minor>)" >&2
      exit 2
      ;;
  esac
done
