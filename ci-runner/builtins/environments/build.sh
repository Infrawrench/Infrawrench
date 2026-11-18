#!/usr/bin/env bash
# The `env:` environments: sets of Wasmer packages (webc) that a job's `run:`
# script executes in. bash runs as a WASIX program and spawns every other
# command from the same set of packages, all inside the one isolate.
#
#   env:bash       bash, coreutils, sed, grep, findutils and Git
#   env:bash-node  the same plus Edge.js (node, npm and pnpm)
#   env:python     the same as env:bash plus CPython with pip
#   env:php        the same as env:bash plus PHP (Wasmer's phpix), Composer
#                  and a `php` that behaves like php-cli (php-cli/build.sh)
#   env:go         the same as env:bash plus a Go toolchain (five minors)
#   env:postgres   the same as env:bash plus PostgreSQL (Wasmer's pglite)
#                  and pglite-server, for a job's `services:`
#   env:clickhouse the same as env:bash-node plus ClickHouse 26.11
#                  (CloudHouse for one-thread WebAssembly) behind its HTTP
#                  interface, `clickhouse-server`, for a job's `services:`
##   env:aws        the same as env:python plus the AWS CLI (version 1)
#   env:az         the same as env:python plus the Azure CLI
#   env:gcloud     the same as env:python plus the Google Cloud CLI
#                  (cloud-clis/build.sh, README.md "Cloud CLIs")
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
# Eight packages are not taken from the CDN as they are. `edgejs/build.sh`
# builds Wasmer's Edge.js 0.2.5 from source on a C library without the races
# behind #937 and #967, which no Wasmer release has yet; `bash/build.sh` and
# `sed/build.sh` change the one call in Wasmer's bash 1.0.25 and sed 4.9.0
# that split an argument at its line feeds (#1003, #1022);
# `python/build.sh` gives Wasmer's CPython the runner's file locks (#1216);
# `php-cli/build.sh` packages env:php's own `php` and Composer; and
# `pglite-server/build.sh` env:postgres's server for many connections;
# `git/build.sh` builds Git, which Wasmer does not publish, from its
# release; and `clickhouse/build.sh` builds env:clickhouse's ClickHouse from
# CloudHouse with a patch of ours (two to three hours). Each result is pinned here by hash like the others, so a build
# that comes out different fails.
#
#   environments/build.sh              all of them
#   environments/build.sh bash         just this one (Linux, x86_64 or
#                                      arm64, to build Git; or its webc
#                                      already in dist/package/git/ and
#                                      macOS on arm64: patch-module.sh's
#                                      Wasmer CLI)
#   environments/build.sh python       the same
#   environments/build.sh aws          the same as python, and the CLI's
#                                      packages (cloud-clis/build.sh, Linux,
#                                      x86_64 or ARM64); likewise az, gcloud
#   environments/build.sh php          every PHP version (Linux, x86_64 or
#                                      ARM64, to build php-cli)
#   environments/build.sh go           every Go minor: builds each with
#                                      go/build.sh (Linux, x86_64 or arm64),
#                                      or uses its webcs already in
#                                      dist/package/go/
#   environments/build.sh go@1.25      just that minor
#   environments/build.sh postgres     the same as bash, on Linux (x86_64 or
#                                      ARM64) to build pglite-server
#   environments/build.sh bash-node    needs the Edge.js build: x86_64 Linux,
#                                      or its webc already in dist/package/
#   environments/build.sh clickhouse   the same as bash-node, and the
#                                      ClickHouse build (Linux, x86_64 or
#                                      ARM64) or its webc already in
#                                      dist/package/clickhouse/
#
# Needs: curl, shasum, and what patch-module.sh and git/build.sh need;
# bash-node, php, postgres and clickhouse also what edgejs/build.sh,
# php-cli/build.sh, pglite-server/build.sh and clickhouse/build.sh need.
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
# Git, built by git/build.sh from its release for WASIX; the hash is its
# output's, as with Edge.js. Every environment has it (README.md, "Git").
GIT_PKG="iwci/git 2.56.1-iwci.2 841a8d6b293c94ff2879186dae83989e7b1893c41768532d15cb09c8f415d876"
# Built by python/build.sh as 3.13.20-iwci.2, keeping Wasmer's version the
# same way: Wasmer's CPython with file locks (#1216), which does not pass its
# own PYTHONEXECUTABLE on to the programs it starts (#1310).
PYTHON_PKG="python/python 3.13.20 b2fa55739ac03c1b23cbe6ffc298bdcc981e5094949944b51c5e83313cc692da 3.13.20-iwci.2"
PHP81_PKG="phpix/phpix-81-64bit 0.3.1 48312c144634ffa5ea1eaef13b48f9b626a947bab6179685ec5196528f81362f"
PHP82_PKG="phpix/phpix-82-64bit 0.3.1 3e05a9e6546757ffee72bc1d19c26b1a62a92dcaadda2a42c36f1fdc2a7a3754"
PHP83_PKG="phpix/phpix-83-64bit 0.3.1 d2ff745903b5c6130662a198d330456daf8cb953438a0d8b8246130a3fb25043"
PHP84_PKG="phpix/phpix-84-64bit 0.3.1 87544a1e1f2aa90d51a8e03f7c488688a13c76e60bf66bd2e24259cd53a9d818"
PHP85_PKG="phpix/phpix-85-64bit 0.3.1 b7e965aad52225c843d0b2540e060f097bd431adcdf228de387c395f435dc074"
SENDMAIL_PKG="sendmail/sendmail 0.1.10 95e52a98e0e684c681c128a07a8031ed284cb5bea71b73a74a44d037a5288d13"
ICU_DATA_PKG="wasmer/icu-data 78.3.0 6e27d8c3828d52fb7ad66afb8438d4c18dde7f5b8dffae7069bc1fd989076c20"
# PostgreSQL 18.4 compiled for WASIX, with its wire protocol on a socket of
# its own (5432). One backend, so one client connection, after which it
# exits; the database is in memory. A service (`services:`), not a job's
# own environment: README.md, "Services".
PGLITE_PKG="wasmer/pglite 0.2.0 4dd0b5db74b06ecf899f19fae460fd775fbb7a6a93663541786efacd633c7a10"
# Built by pglite-server/build.sh: many connections over pglite's one, a
# transaction at a time, and a pgcrypto (pglite has no OpenSSL). Its hash is
# its output's, as with Edge.js.
PGLITE_SERVER_PKG="iwci/pglite-server 1.0.0 2ee4e13f7554cc290a6954508f157292646966e15998d583468ba0a422cecab4"
# Built by clickhouse/build.sh: ClickHouse 26.11 (CloudHouse's
# `clickhouse-ci` target, cloudhouse-ci.patch) and the HTTP server in front
# of it, at /opt/clickhouse. Its hash is its output's, as with Edge.js.
CLICKHOUSE_PKG="iwci/clickhouse 26.11.1-iwci.1 6ba689f8796a2ec446beac57d8d958ce2f8a5783c16117a7abe4397c6697eb9b"
# env:clickhouse's `clickhouse-server` (README.md, "ClickHouse").
CLICKHOUSE_ENV='"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/clickhouse/bin"'
# python/python's version is Wasmer's, not the interpreter's: 3.13.20 holds
# CPython 3.13.15, which named the environment's first version. Its prefix is
# a Nix store path inside the package, where pip puts console scripts
# (`pytest`).
PYTHON_PREFIX="/nix/store/wf0002v5izqcb7kg59n8cilx58lcp373-python3-static-wasm32-unknown-wasi-3.13.15"
# What `pip install` and pytest need here (README.md, "Python"):
#   PATH  the default plus where pip puts console scripts: the user site's
#     first, then the interpreter's.
#   PYTHONUSERBASE  the user site, /root/.local as on Linux. CPython on
#     WASIX has no user base without it (site.py: no home directories
#     there), so `pip install --user` refused ("User site-packages are
#     disabled") and `deps: [pip]` had to set it.
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
PYTHON_ENV='"PATH": "/root/.local/bin:/usr/local/bin:/usr/bin:/bin:'"$PYTHON_PREFIX"'/bin",
    "PYTHONUSERBASE": "/root/.local",
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
# What global installs need in env:bash-node (README.md, "Global installs"):
#   PNPM_HOME  where `pnpm add -g` (and `npm i -g`, which Edge.js runs as
#     pnpm) installs and links commands; pnpm refuses a global install
#     without it. It is pnpm's own default on Linux.
#   PATH  the default plus that directory, after the system's, so a
#     global install cannot shadow a command the environment ships.
BASH_NODE_ENV='"PATH": "/usr/local/bin:/usr/bin:/bin:/root/.local/share/pnpm",
    "PNPM_HOME": "/root/.local/share/pnpm"'
# The cloud CLIs, built by cloud-clis/build.sh on env:python's CPython;
# each hash is its output's, as with Edge.js. The Azure CLI and gcloud are
# two packages each (the store's 256 MiB per file).
AWS_CLI_PKG="iwci/aws-cli 1.46.3-iwci.1 542d9c4f0b40cddb158fafdd6a72488a441c6725537143bcb578f76121f336d7"
AZURE_CLI_PKG="iwci/azure-cli 2.92.0-iwci.2 a34e6ae487c9aca37800c3f18d4a293b9104b17532cba6fc75a97571391b288d"
AZURE_CLI_MGMT_PKG="iwci/azure-cli-mgmt 2.92.0-iwci.1 59b670548a0b6de0d96378f587405a46d226cfe067c2c15d2dbb03c0eae3c3d8"
GCLOUD_PKG="iwci/gcloud 593.0.0-iwci.1 47e6d58f2373a27d72d23e62a5b8571c74186410c827fe00f4446e4448fbb8a4"
GCLOUD_APIS_PKG="iwci/gcloud-apis 593.0.0-iwci.1 74d94ed1d43a7eb1f49ebb23f154f48073f424d84b6bf63efe4920b04cf3a410"
# What each CLI needs here beyond env:python's defaults (README.md, "Cloud
# CLIs"): its bin/ on PATH after /usr/local/bin, and:
#   AWS_PAGER  empty: no pager, the output goes to the log.
#   AWS_EC2_METADATA_DISABLED  never ask the instance metadata service for
#     credentials or a region: a job cannot reach it (the network refuses
#     link-local addresses) and the CLI would wait on it first.
#   CLOUDSDK_CORE_DISABLE_PROMPTS  no prompts: nobody answers one.
#   CLOUDSDK_CORE_CHECK_GCE_METADATA, NO_GCE_CHECK  gcloud's and Google's
#     auth libraries' own metadata server probes, off for the same reason.
#   CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK  no check for a newer
#     gcloud, which this one cannot install.
#   CLOUDSDK_PYTHON  the environment's CPython, for gcloud's own children.
#   AZURE_CORE_COLLECT_TELEMETRY  the Azure CLI uploads usage data from a
#     process it leaves behind; off.
#   AZURE_CORE_SURVEY_MESSAGE, AZURE_CORE_NO_COLOR  no survey prompt, and
#     plain text in the log.
# cloud_env <dir>: env:python's defaults with <dir> on PATH right after
# /usr/local/bin (the job's tools), wherever that sits in PATH (the user
# site's bin comes first since python 3.13.19). Fails rather than build an
# environment whose CLI is not on PATH.
cloud_env() {
  local env="${PYTHON_ENV/\/usr\/local\/bin:/\/usr\/local\/bin:$1:}"
  if [[ "$env" == "$PYTHON_ENV" || "$env" != *"\"PATH\": \""*"$1:"* ]]; then
    echo "error: cannot put $1 on env:python's PATH" >&2
    exit 1
  fi
  printf '%s' "$env"
}
AWS_ENV="$(cloud_env /opt/aws-cli/bin)"',
    "AWS_PAGER": "",
    "AWS_EC2_METADATA_DISABLED": "true"'
AZ_ENV="$(cloud_env /opt/azure-cli/bin)"',
    "AZURE_CORE_COLLECT_TELEMETRY": "no",
    "AZURE_CORE_SURVEY_MESSAGE": "no",
    "AZURE_CORE_NO_COLOR": "true"'
GCLOUD_ENV="$(cloud_env /opt/google-cloud-sdk/bin)"',
    "CLOUDSDK_CORE_DISABLE_PROMPTS": "1",
    "CLOUDSDK_CORE_CHECK_GCE_METADATA": "false",
    "NO_GCE_CHECK": "True",
    "CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK": "true",
    "CLOUDSDK_PYTHON": "/usr/bin/python3"'
# Built by edgejs/build.sh, which names the version; the hash is its output's.
EDGEJS_PKG="wasmer/edgejs 0.2.5-iwci.16 117f4e175cd715177f666d0991d9e82bdcfe6c20ba30d657bdc1fa5c03589707"
# Go, built by go/build.sh <minor> as two packages: the toolchain, and the
# standard library's build cache (together over the store's per-file limit).
# Each line is the environment's version, then the packages'. The
# environment's version was the Go release's until Git came in: its patch
# number is now the environment's own revision, as with the others.
go_pkgs() {
  case "$1" in
    1.23) echo "1.23.15 1.23.12-iwci.1 44d930abee67f242d273386fb76af0fb66cae73b37bde9e3addd4cff9dd105b0 8de9b4ff060b272b8857d0cef043e46d23ecf481374310eadebfe2cda10b4355" ;;
    1.24) echo "1.24.16 1.24.13-iwci.1 fc66f7a45ce73e9a4246194147bd68b0294a68024f8d15ba44f6ef28d30f563c f953cbc478c9f52f714e3c58c548b01e2f4ed7a48ce758736f9156151e6c154f" ;;
    1.25) echo "1.25.17 1.25.14-iwci.1 748fe2d628d8700db3c8977fddb27bbe14622d3729f5664d23e4f7e73d1f7238 b7a89719757bc0c7d050f13d52d13622124aa1c876149cb4e109b6d108d2623d" ;;
    1.26) echo "1.26.14 1.26.11-iwci.1 0b8375201683a9a00f2e7d9d6593ada7dd10d93b56f3f4da5173d024a6dfb5b8 93147c7f4879f44374f93e414d37ba975d48816c55d28454f7e8583d83bbb767" ;;
    1.27) echo "1.27.7 1.27.4-iwci.1 16f9793e874e82e85cde25d4e569b7df1b27707cfa42d37c29dc62270e362b97 20f2c885e5b89ec967abd98eed137da2460eab3e33b1b2a3da15bbd5b820f2d5" ;;
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
# The environment's caches (README.md, "Environment caches"): what a job adds
# to GOCACHE beside the standard library comes back on its next run. 1 GiB
# at most, and never more than a quarter of the job's memory. The standard
# library's entries are dated 2100 and so is its trim.txt, so Go never trims
# here: past the limit the runner keeps only what the last run wrote.
GO_CACHES='{ "name": "go-build", "path": "/root/.cache/go-build", "max-bytes": 1073741824 }'
# CRuby, built by ruby/build.sh <minor> for WASIX (README.md, "Ruby"). Each
# line is the environment's version, the package's, its hash, and the
# directory gems install into (Gem.user_dir for /root, named after the
# minor's ruby_version). The environment's version starts as Ruby's own and
# its patch number is the environment's revision after that, as with Go.
# Ruby's release plus one: `exec` passes the environment as ENV has it, so
# `bundle exec ruby` runs with the bundle (#1303).
ruby_pkgs() {
  case "$1" in
    3.4) echo "3.4.13 3.4.12-iwci.4 dea9e54310da58c5bd1b45c60fdee8d1d24847a4cb5e364e5af9658b7cb34141 3.4.0" ;;
    4.0) echo "4.0.10 4.0.9-iwci.4 f20fb3b5a96fe6464363e0a8665cb452fc39fffe3ad3d8eec9f4df3a6437828a 4.0.0" ;;
    *) return 1 ;;
  esac
}
RUBY_MINORS=(3.4 4.0)
# What Ruby jobs need here (README.md, "Ruby"):
#   GEM_HOME  where `gem install` and `bundle install` put gems: the user
#     directory RubyGems would pick for root (Gem.user_dir), since the
#     interpreter's own is part of the package. BUNDLE_* is left to the job
#     and to `deps: [bundler]`, which sets them per job.
#   PATH  that directory's bin/ first, as env:python puts the user site's,
#     then the default with /opt/ruby/bin (gem, bundle, rake, irb, ...)
#     ahead of /usr/bin, which has `ruby` itself.
ruby_env() {
  printf '"PATH": "/root/.local/share/gem/ruby/%s/bin:/usr/local/bin:/opt/ruby/bin:/usr/bin:/bin",
    "GEM_HOME": "/root/.local/share/gem/ruby/%s"' "$1" "$1"
}

fetch() {
  local dir="$1" name="$2" version="$3" sha="$4" build="${5:-$3}"
  local file="$dir/${name//\//-}-$version.webc"
  local ours=""
  case "$name" in
    wasmer/bash) ours=bash ;;
    wasmer/sed) ours="sed" ;;
    python/python) ours=python ;;
    wasmer/edgejs) ours=edgejs ;;
    iwci/php-cli) ours="php-cli" ;;
    iwci/pglite-server) ours="pglite-server" ;;
    iwci/git) ours=git ;;
    iwci/clickhouse) ours=clickhouse ;;
  esac
  local cli=""
  case "$name" in
    iwci/aws-cli) cli=aws ;;
    iwci/azure-cli | iwci/azure-cli-mgmt) cli=az ;;
    iwci/gcloud | iwci/gcloud-apis) cli=gcloud ;;
  esac
  if [[ -n "$cli" ]]; then
    # Ours: cloud-clis/build.sh makes each CLI's packages.
    local built="$dist/package/${name#iwci/}/$version/${name#iwci/}.webc"
    [[ -f "$built" ]] || bash "$here/environments/cloud-clis/build.sh" "$cli" >&2
    cp "$built" "$file"
  elif [[ -n "$ours" ]]; then
    # Ours: built here unless a build (or CI's cache of one) is in place.
    local built="$dist/package/$ours/$build/$ours.webc"
    [[ -f "$built" ]] || bash "$here/environments/$ours/build.sh" >&2
    cp "$built" "$file"
  elif [[ "$name" == iwci/go* ]]; then
    # Ours too: go/build.sh <minor> makes both of a minor's packages.
    local built="$dist/package/go/$version/${name#iwci/}.webc"
    [[ -f "$built" ]] || bash "$here/environments/go/build.sh" "$(cut -d. -f1-2 <<<"$version")" >&2
    cp "$built" "$file"
  elif [[ "$name" == iwci/ruby ]]; then
    # Ours too: ruby/build.sh <minor>.
    local built="$dist/package/ruby/$version/ruby.webc"
    [[ -f "$built" ]] || bash "$here/environments/ruby/build.sh" "$(cut -d. -f1-2 <<<"$version")" >&2
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
# $CACHES, when set, is the manifest's `caches` as JSON array items
# (README.md, "Environment caches").
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
  # Built here: inside the heredoc, `${CACHES:+...}` would strip its quotes.
  local caches=""
  if [[ -n "${CACHES:-}" ]]; then
    caches=$'\n  "caches": ['"$CACHES"'],'
  fi
  cat >"$out/build.json" <<JSON
{
  "kind": "environment",
  "name": "$name",
  "version": "$version",
  "entry": "bash",
  "packages": [$joined],
  "env": { $env },$caches
  "description": "$description"
}
JSON
  echo "built $out"
}

TOOLS=("$BASH_PKG" "$COREUTILS_PKG" "$SED_PKG" "$GREP_PKG" "$FINDUTILS_PKG" "$GIT_PKG")
if [[ $# -eq 0 ]]; then
  set -- bash bash-node python php go ruby postgres aws az gcloud
fi
for env in "$@"; do
  case "$env" in
    bash)
      # 5.1.17: an argument with a line feed in it reaches the program whole
      # (#1003).
      # 5.1.18: and so does a command sed's `e` runs (#1022).
      # 5.1.19: and Git.
      # 5.1.20: and Git's prompts read /dev/tty, so they end at once (#1264).
      build_env bash 5.1.20 "GNU bash 5.1 with coreutils, sed, grep, findutils and Git" "" "${TOOLS[@]}"
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
      # 24.0.8: and `node` starts from a code cache of its built-ins that the
      #         runner makes (#996), `vm.Script#createCachedData()` works
      #         (#1007, in the runner), and so do `worker.cpuUsage()`
      #         (#1006) and Node's CPU times (#1038).
      # 24.0.9: and Git.
      # 24.0.10: and `fs.open` with numeric flags 0 opens read-only (#1045),
      #          and `structuredClone` and `postMessage` keep integer-like
      #          keys, shared references and cycles (#1048).
      # 24.0.11: and a child's exit is seen within 100 ms with a timer
      #          pending, so `spawnSync` with a timeout no longer runs to
      #          it (#1065).
      # 24.0.12: and `postMessage` of a large value arrives whole, or throws
      #          (#1061).
      # 24.0.13: and `process.report.getReport()` no longer signals a
      #          condition variable in a frame that has returned (#1070).
      # 24.0.14: and asking a starting or ending Worker for its heap
      #          statistics or CPU use writes into no freed memory (#1070).
      # 24.0.15: and Node's module compile cache (`NODE_COMPILE_CACHE`,
      #          `module.enableCompileCache()`) works.
      # 24.0.16: and an ES module that does not parse prints where once,
      #          with its caret (#1097).
      # 24.0.17: and an uncaught exception is reported as Node reports it
      #          (#1141, #1142, #1143).
      # 24.0.18: and `node --version` says what `process.version` does
      #          (#1151).
      # 24.0.19: and `npm i -g` and `pnpm add -g` put commands on PATH.
      # 24.0.20: and Git's prompts read /dev/tty, so they end at once (#1264).
      # 24.0.21: and Workers writing one compile cache entry at once leave
      #          one of theirs, never none (#1249).
      build_env bash-node 24.0.21 "GNU bash 5.1, coreutils, sed, grep, findutils, Git and Edge.js (Node 24 compatible, npm and pnpm)" "$BASH_NODE_ENV" \
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
        # Go's release plus one: and Git.
        # Plus two: and a job keeps what it adds to its build cache (#1083).
        # Plus three: and Git's prompts read /dev/tty (#1264).
        read -r env_version version go_sha cache_sha <<<"$pkgs"
        CACHES="$GO_CACHES" build_env go "$env_version" "GNU bash 5.1, coreutils, sed, grep, findutils, Git and Go ${version%-iwci.*} (go, gofmt)" \
          "$GO_ENV" "${TOOLS[@]}" "iwci/go $version $go_sha" "iwci/go-std-cache $version $cache_sha"
      done
      ;;
    python)
      # 3.13.16: bash passes an argument with a line feed in it whole (#1003).
      # 3.13.17: and so does sed's `e` command (#1022).
      # 3.13.18: and Git.
      # 3.13.19: and `pip install --user`, its commands on PATH.
      # 3.13.20: and Git's prompts read /dev/tty, so they end at once (#1264).
      # 3.13.21: and `fcntl.flock` and `fcntl.lockf` lock (#1216).
      # 3.13.22: and `python -m venv` installs pip into the venv (#1310).
      build_env python 3.13.22 "GNU bash 5.1, coreutils, sed, grep, findutils, Git and CPython 3.13.15 with pip" \
        "$PYTHON_ENV" "${TOOLS[@]}" "$PYTHON_PKG"
      ;;
    aws)
      # Its version is the AWS CLI's major and minor, as python's is
      # CPython's; its patch number is the environment's own.
      # 1.46.1: Git's prompts read /dev/tty (#1264).
      # 1.46.2: and file locks (#1216).
      # 1.46.3: and `python -m venv` installs pip into the venv (#1310).
      build_env aws 1.46.3 "GNU bash 5.1, coreutils, sed, grep, findutils, Git, CPython 3.13.15 with pip, and the AWS CLI 1.46.3" \
        "$AWS_ENV" "${TOOLS[@]}" "$PYTHON_PKG" "$AWS_CLI_PKG"
      ;;
    az)
      # 2.92.1: Git's prompts read /dev/tty (#1264).
      # 2.92.2: and file locks (#1216), so `az` takes its token cache's.
      # 2.92.3: and `python -m venv` installs pip into the venv (#1310).
      build_env az 2.92.3 "GNU bash 5.1, coreutils, sed, grep, findutils, Git, CPython 3.13.15 with pip, and the Azure CLI 2.92.0" \
        "$AZ_ENV" "${TOOLS[@]}" "$PYTHON_PKG" "$AZURE_CLI_PKG" "$AZURE_CLI_MGMT_PKG"
      ;;
    gcloud)
      # gcloud's releases are one number (593.0.0); the environment's patch
      # number is its own revision.
      # 593.0.1: Git's prompts read /dev/tty (#1264).
      # 593.0.2: and file locks (#1216).
      # 593.0.3: and `python -m venv` installs pip into the venv (#1310).
      build_env gcloud 593.0.3 "GNU bash 5.1, coreutils, sed, grep, findutils, Git, CPython 3.13.15 with pip, and the Google Cloud CLI 593.0.0 (gcloud, bq)" \
        "$GCLOUD_ENV" "${TOOLS[@]}" "$PYTHON_PKG" "$GCLOUD_PKG" "$GCLOUD_APIS_PKG"
      ;;
    php)
      # phpix 0.3.1 holds PHP 8.1.34, 8.2.35, 8.3.36, 8.4.27 and 8.5.12,
      # which were also the environments' first versions. Each line is the
      # environment's version, then PHP's, then the package.
      # +1 on each: bash passes an argument with a line feed in it whole
      # (#1003).
      # +2: and so does sed's `e` command (#1022).
      # +3: and Git.
      # +4: and Git's prompts read /dev/tty (#1264).
      for pkg in "8.1.38 8.1.34 $PHP81_PKG" "8.2.39 8.2.35 $PHP82_PKG" "8.3.40 8.3.36 $PHP83_PKG" \
        "8.4.31 8.4.27 $PHP84_PKG" "8.5.16 8.5.12 $PHP85_PKG"; do
        read -r version php package <<<"$pkg"
        build_env php "$version" "GNU bash 5.1, coreutils, sed, grep, findutils, Git, PHP $php (Wasmer's phpix) and Composer" \
          "$PHP_ENV" "${TOOLS[@]}" "$package" "$SENDMAIL_PKG" "$ICU_DATA_PKG" "$PHP_CLI_PKG"
      done
      ;;
    postgres)
      # Its version is PostgreSQL's, as python's is CPython's.
      # 18.4.1: and pglite-server, for many connections and pgcrypto.
      # 18.4.2: and Git.
      # 18.4.3: and Git's prompts read /dev/tty (#1264).
      build_env postgres 18.4.3 "GNU bash 5.1, coreutils, sed, grep, findutils, Git and PostgreSQL 18.4 (Wasmer's pglite, in memory; pglite-server for many connections)" \
        "" "${TOOLS[@]}" "$PGLITE_PKG" "$PGLITE_SERVER_PKG"
      ;;
    clickhouse)
      # Its version is ClickHouse's major and minor, as postgres's is
      # PostgreSQL's; its patch number is the environment's own.
      # 26.11.1: bash-node 24.0.16's Edge.js (#1097).
      # 26.11.2: bash-node 24.0.17's Edge.js (#1141, #1142, #1143).
      # 26.11.3: bash-node 24.0.18's Edge.js (#1151).
      # 26.11.4: and Git's prompts read /dev/tty (#1264).
      # 26.11.5: bash-node 24.0.21's Edge.js (#1249).
      build_env clickhouse 26.11.5 "GNU bash 5.1, coreutils, sed, grep, findutils, Git, Edge.js and ClickHouse 26.11 (CloudHouse for one-thread WebAssembly) as clickhouse-server, for services:" \
        "$CLICKHOUSE_ENV" "${TOOLS[@]}" "$EDGEJS_PKG" "$CLICKHOUSE_PKG"
      ;;
    ruby | ruby@*)
      minors=("${RUBY_MINORS[@]}")
      [[ "$env" == ruby ]] || minors=("${env#ruby@}")
      for minor in "${minors[@]}"; do
        if ! pkgs="$(ruby_pkgs "$minor")"; then
          echo "error: no Ruby $minor; know ${RUBY_MINORS[*]}" >&2
          exit 2
        fi
        read -r env_version version ruby_sha api <<<"$pkgs"
        build_env ruby "$env_version" "GNU bash 5.1, coreutils, sed, grep, findutils, Git and CRuby ${version%-iwci.*} (ruby, gem, bundle, rake, irb), built for WASIX" \
          "$(ruby_env "$api")" "${TOOLS[@]}" "iwci/ruby $version $ruby_sha"
      done
      ;;
    *)
      echo "error: no environment \`$env\`; know bash, bash-node, python, php, go (or go@<minor>), ruby (or ruby@<minor>), postgres, clickhouse, aws, az and gcloud" >&2
      exit 2
      ;;
  esac
done
