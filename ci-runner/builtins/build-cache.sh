#!/usr/bin/env bash
# The build cache: CI's slow builds of builtins and packages (ClickHouse
# takes hours, Edge.js ten minutes), kept in the runner pool's bucket under
# build-cache/ and keyed by a SHA-256 of what each is built from. A job asks
# for the build of its key: a hit is downloaded and checked, a miss is built
# and stored. README.md, "The build cache", has the design.
#
#   build-cache.sh fetch <name>...  restore each if its key is stored; with
#                                   one name, sets `hit` (true or false) in
#                                   $GITHUB_OUTPUT
#   build-cache.sh build <name>...  restore each, or build it and store it
#   build-cache.sh store <name>...  store what is already in dist/, checked
#                                   as a fetch is (to seed from a build made
#                                   elsewhere)
#   build-cache.sh key <name>...    print each key and what went into it
#
# Names, and what each builds (spec below): clickhouse, edgejs, git,
# go@<minor>, kubectl@<minor>, openssh, typescript, oxfmt.
#
# The key is the SHA-256 of a listing, stored beside each entry as
# inputs.txt:
#   - BUILD_CACHE_VERSION below, a salt: bump it to rebuild everything;
#   - the name and its spec: input paths, outputs, build command, and the
#     environment variables its build script reads as overrides;
#   - the platform: `uname -s -m` and /etc/os-release's ID and VERSION_ID
#     (ubuntu 24.04 on x86_64 or aarch64 in CI);
#   - BUILD_CACHE_TOOLCHAIN: what the workflow job installs for the build
#     (Binaryen, Node, cargo-wasix), when it sets it;
#   - the path, mode and SHA-256 of every file under each input path, in
#     byte order. Each build.sh pins its upstream sources and toolchains by
#     commit, tag or hash, so those pins are in the key with it.
# Too much in a key costs a rebuild; too little serves a stale build.
#
# Scopes, so that a pull request cannot change what main builds from:
#   a push, schedule or dispatch on main   read and write main/
#   a pull request from this repository    read main/, then pr/<number>/;
#                                          write pr/<number>/ (a lifecycle
#                                          rule expires it after 14 days)
#   anything else with credentials         read main/
#   no credentials (a fork's pull request  build, as without a cache
#   or a local run), or BUILD_CACHE=off
# A scheduled run rebuilds the specs marked REFRESH instead of reading them
# (their toolchains are not pinned byte for byte, which is what the nightly
# run is there to catch) and stores the new build over the old.
#
# An entry is build-cache/<scope>/<name>/<key>/: payload-<sha256>.tar.gz (the
# outputs, paths relative to ci-runner/), inputs.txt, and manifest.json,
# written last, which names the payload and its hash, the commit and the run.
# A payload is checked against its hash and its paths against the spec's
# outputs before it is unpacked, and outputs with pinned hashes are checked
# against those pins after (verify below); an entry that fails either is a
# miss, and is built again.
#
# R2 through the AWS CLI, with publish.sh's IWCI_R2_ACCOUNT_ID,
# IWCI_R2_BUCKET, IWCI_R2_ACCESS_KEY_ID and IWCI_R2_SECRET_ACCESS_KEY.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

BUILD_CACHE_VERSION=1
root="$(cd -- "$here/.." && pwd)"
cd "$root"
if [[ -n "${DIST:-}" ]]; then
  echo "build-cache.sh: works on ci-runner/dist/ (its outputs are paths in it); unset DIST" >&2
  exit 2
fi
state="dist/.build-cache"

# spec <name>: what <name> is built from and into.
#   INPUTS   paths (relative to ci-runner/) whose files go into the key
#   ENVS     variables the build script reads as overrides
#   OUTPUTS  what the build leaves, as patterns matched after it
#   BUILD    the command
#   VERIFY   a check of the outputs against their pins, or empty
#   REFRESH  1: a scheduled run rebuilds rather than reads
spec() {
  local minor
  INPUTS=(builtins/lib.sh) ENVS=() OUTPUTS=() BUILD=() VERIFY=() REFRESH=0
  case "$1" in
    clickhouse)
      INPUTS+=(builtins/environments/clickhouse)
      OUTPUTS=(dist/package/clickhouse)
      BUILD=(bash builtins/environments/clickhouse/build.sh)
      VERIFY=(verify_package CLICKHOUSE_PKG clickhouse)
      ;;
    edgejs)
      INPUTS+=(builtins/environments/edgejs)
      ENVS=(EDGEJS_VERIFY)
      OUTPUTS=(dist/package/edgejs)
      BUILD=(bash builtins/environments/edgejs/build.sh)
      VERIFY=(verify_package EDGEJS_PKG edgejs)
      ;;
    git)
      # And the C library patches it shares with Edge.js.
      INPUTS+=(builtins/environments/git builtins/environments/edgejs/wasix-libc-*.patch)
      OUTPUTS=(dist/package/git)
      BUILD=(bash builtins/environments/git/build.sh)
      VERIFY=(verify_package GIT_PKG git)
      ;;
    go@*)
      minor="${1#go@}"
      INPUTS+=(builtins/environments/go/build.sh "builtins/environments/go/$minor")
      OUTPUTS=("dist/package/go/$minor.*")
      BUILD=(bash builtins/environments/go/build.sh "$minor")
      VERIFY=(verify_go "$minor")
      ;;
    kubectl@*)
      # And env:go's build script, pins and patch series, which it builds with.
      minor="${1#kubectl@}"
      INPUTS+=(builtins/kubectl builtins/environments/go)
      OUTPUTS=("dist/builtin/kubectl/$minor.*" dist/test/kubectl)
      BUILD=(bash builtins/kubectl/build.sh "$minor")
      VERIFY=(verify_kubectl "$minor")
      ;;
    openssh)
      # And Git's build script (it reads Git's toolchain pins), the C
      # library patches, and env:go's toolchain, which builds its test server.
      INPUTS+=(builtins/openssh builtins/environments/git builtins/environments/edgejs/wasix-libc-*.patch
        builtins/environments/go)
      OUTPUTS=(dist/builtin/ssh dist/builtin/scp dist/builtin/sftp dist/builtin/ssh-keygen dist/builtin/ssh-keyscan
        dist/test/openssh)
      BUILD=(bash builtins/openssh/build.sh)
      VERIFY=(verify_openssh)
      ;;
    typescript)
      INPUTS+=(builtins/typescript rust-toolchain.toml)
      ENVS=(TSC_RS_TAG TS_VERSION)
      OUTPUTS=(dist/builtin/typescript)
      BUILD=(bash builtins/typescript/build.sh)
      REFRESH=1
      ;;
    oxfmt)
      INPUTS+=(builtins/oxfmt rust-toolchain.toml)
      ENVS=(OXC_TAG OXFMT_VERSION)
      OUTPUTS=(dist/builtin/oxfmt)
      BUILD=(bash builtins/oxfmt/build.sh)
      REFRESH=1
      ;;
    *)
      echo "build-cache.sh: no build \`$1\`; know clickhouse, edgejs, git, go@<minor>, kubectl@<minor>, openssh, typescript and oxfmt" >&2
      exit 2
      ;;
  esac
  if [[ -n "${minor:-}" && ! "$minor" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "build-cache.sh: \`$1\` names no minor version" >&2
    exit 2
  fi
  local input
  for input in "${INPUTS[@]}"; do
    if [[ ! -e "$input" ]]; then
      echo "build-cache.sh: $1 is built from $input, which is not there" >&2
      exit 2
    fi
  done
}

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

note() {
  echo "build-cache: $*"
}

warn() {
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    echo "::warning title=Build cache::$*"
  else
    echo "build-cache: warning: $*" >&2
  fi
}

platform() {
  local os="unknown"
  if [[ -r /etc/os-release ]]; then
    os="$(sed -n 's/^ID=//p' /etc/os-release) $(sed -n 's/^VERSION_ID=//p' /etc/os-release)"
  fi
  printf '%s %s' "$(uname -s -m)" "${os//\"/}"
}

# inputs <name>: the listing the key hashes. spec must have run.
inputs() {
  local name var file mode
  name="$1"
  printf 'build-cache %s\n' "$BUILD_CACHE_VERSION"
  printf 'name %s\n' "$name"
  printf 'inputs %s\n' "${INPUTS[*]}"
  printf 'outputs %s\n' "${OUTPUTS[*]}"
  printf 'build %s\n' "${BUILD[*]}"
  printf 'platform %s\n' "$(platform)"
  printf 'toolchain %s\n' "${BUILD_CACHE_TOOLCHAIN:-}"
  for var in ${ENVS[@]+"${ENVS[@]}"}; do
    if [[ -n "${!var+set}" ]]; then
      printf 'env %s=%s\n' "$var" "${!var}"
    else
      printf 'env %s unset\n' "$var"
    fi
  done
  while IFS= read -r -d '' file; do
    mode=644
    [[ -x "$file" ]] && mode=755
    printf 'file %s %s %s\n' "$mode" "$(sha256 <"$file")" "$file"
  done < <(find "${INPUTS[@]}" '(' -type f -o -type l ')' -print0 | LC_ALL=C sort -zu)
}

# The scopes this run reads, in order, and the one it writes (empty: none).
scopes() {
  READ=(main) WRITE=""
  case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
    push:refs/heads/main | schedule:refs/heads/main | workflow_dispatch:refs/heads/main)
      WRITE=main
      ;;
    pull_request:refs/pull/*/merge)
      local number="${GITHUB_REF#refs/pull/}"
      number="${number%/merge}"
      if [[ "$number" =~ ^[0-9]+$ ]]; then
        READ+=("pr/$number")
        WRITE="pr/$number"
      fi
      ;;
  esac
}

# Whether this run can reach the cache at all.
enabled() {
  [[ "${BUILD_CACHE:-}" != off ]] || return 1
  local var
  for var in IWCI_R2_ACCOUNT_ID IWCI_R2_BUCKET IWCI_R2_ACCESS_KEY_ID IWCI_R2_SECRET_ACCESS_KEY; do
    [[ -n "${!var:-}" ]] || return 1
  done
  command -v aws >/dev/null || {
    warn "no AWS CLI here, so no build cache"
    return 1
  }
}

r2() {
  env -u AWS_PROFILE \
    AWS_ACCESS_KEY_ID="$IWCI_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$IWCI_R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws --endpoint-url "https://$IWCI_R2_ACCOUNT_ID.r2.cloudflarestorage.com" "$@"
}

# get <key> <file>: fails quietly on a missing object, with a warning on
# anything else.
get() {
  if r2 s3 cp --only-show-errors "s3://$IWCI_R2_BUCKET/$1" "$2" 2>"$SCRATCH/r2.err"; then
    return 0
  fi
  if ! grep -qE '\(404\)|Not Found|NoSuchKey|does not exist' "$SCRATCH/r2.err"; then
    warn "reading $1: $(tr '\n' ' ' <"$SCRATCH/r2.err")"
  fi
  return 1
}

put() {
  r2 s3 cp --only-show-errors "$1" "s3://$IWCI_R2_BUCKET/$2"
}

# The outputs as they are now, every pattern matched (fails on one that
# matches nothing).
outputs() {
  local pattern match found
  OUTPUT_PATHS=()
  for pattern in "${OUTPUTS[@]}"; do
    found=0
    while IFS= read -r match; do
      OUTPUT_PATHS+=("$match")
      found=1
    done < <(compgen -G "$pattern" || true)
    if [[ "$found" == 0 ]]; then
      echo "build-cache.sh: the build left nothing at $pattern" >&2
      return 1
    fi
  done
}

remove_outputs() {
  local pattern match
  for pattern in "${OUTPUTS[@]}"; do
    while IFS= read -r match; do
      rm -rf "$match"
    done < <(compgen -G "$pattern" || true)
  done
}

# Whether every member of the archive is a plain file or directory, at one
# of the outputs or under one.
members_are_outputs() {
  local member pattern ok types
  types="$(tar -tvzf "$1" | cut -c1 | sort -u | tr -d '\n')"
  [[ "$types" =~ ^[-d]+$ ]] || return 1
  while IFS= read -r member; do
    member="${member%/}"
    if [[ "$member" == /* || "/$member/" == */../* ]]; then
      return 1
    fi
    ok=0
    for pattern in "${OUTPUTS[@]}"; do
      # shellcheck disable=SC2053 # The output is a pattern.
      if [[ "$member" == $pattern || "$member" == $pattern/* ]]; then
        ok=1
        break
      fi
    done
    [[ "$ok" == 1 ]] || return 1
  done < <(tar -tzf "$1")
}

# check <file> <sha256>
check() {
  if [[ -z "$2" ]]; then
    echo "build-cache.sh: found no pin for $1" >&2
    return 1
  fi
  if [[ ! -f "$1" ]]; then
    echo "build-cache.sh: $1 is missing" >&2
    return 1
  fi
  local actual
  actual="$(sha256 <"$1")"
  if [[ "$actual" != "$2" ]]; then
    echo "build-cache.sh: $1 hashed to $actual, not the pinned $2" >&2
    return 1
  fi
}

# verify_package <variable> <package>: against environments/build.sh's pin,
# at the path its fetch() reads.
verify_package() {
  local name version sha build
  read -r name version sha build <<<"$(sed -n "s/^$1=\"\(.*\)\"\$/\1/p" builtins/environments/build.sh)"
  check "dist/package/$2/${build:-$version}/$2.webc" "$sha"
}

# verify_go <minor>: both packages, against environments/build.sh's go_pkgs.
verify_go() {
  local version go_sha cache_sha
  read -r _ version go_sha cache_sha <<<"$(sed -n "s/^    ${1//./\\.}) echo \"\(.*\)\" ;;\$/\1/p" builtins/environments/build.sh)"
  check "dist/package/go/$version/go.webc" "$go_sha" &&
    check "dist/package/go/$version/go-std-cache.webc" "$cache_sha"
}

# verify_kubectl <minor>: the module, against kubectl/build.sh's release().
verify_kubectl() {
  local version sha
  read -r version _ _ _ _ sha <<<"$(sed -n "s/^    ${1//./\\.}) echo \"\(.*\)\" ;;\$/\1/p" builtins/kubectl/build.sh)"
  check "dist/builtin/kubectl/$version/module.wasm" "$sha"
}

# verify_openssh: each program's module, against openssh/build.sh's PROGRAMS.
verify_openssh() {
  local version program sha found=0
  version="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' builtins/openssh/build.sh)"
  while read -r program sha; do
    check "dist/builtin/$program/$version/module.wasm" "$sha" || return 1
    found=1
  done < <(sed -n '/^PROGRAMS=(/,/^)/s/^  "\([^ ]*\) \([0-9a-f]\{64\}\)"$/\1 \2/p' builtins/openssh/build.sh)
  [[ "$found" == 1 ]] || {
    echo "build-cache.sh: found no PROGRAMS in openssh/build.sh" >&2
    return 1
  }
}

verify() {
  [[ ${#VERIFY[@]} -eq 0 ]] || "${VERIFY[@]}"
}

key_of() {
  inputs "$1" | sha256
}

# fetch_one <name>: restores <name> and records the result in $state/<name>
# ("hit", or "miss <key>"). Fails on a miss.
fetch_one() {
  local name="$1" key scope prefix payload sha
  spec "$name"
  mkdir -p "$state"
  key="$(key_of "$name")"
  printf 'miss %s\n' "$key" >"$state/$name"
  if ! enabled; then
    note "$name: no cache in this run (no R2 credentials, or BUILD_CACHE=off)"
    return 1
  fi
  if [[ "$REFRESH" == 1 && "${GITHUB_EVENT_NAME:-}" == schedule ]]; then
    note "$name: a scheduled run builds it afresh"
    return 1
  fi
  scopes
  for scope in "${READ[@]}"; do
    prefix="build-cache/$scope/$name/$key"
    rm -f "$SCRATCH/manifest.json" "$SCRATCH/payload.tar.gz"
    get "$prefix/manifest.json" "$SCRATCH/manifest.json" || continue
    payload="$(sed -n 's/^  "payload": "\(payload-[0-9a-f]\{64\}\.tar\.gz\)",$/\1/p' "$SCRATCH/manifest.json")"
    sha="${payload#payload-}"
    sha="${sha%.tar.gz}"
    if [[ -z "$payload" ]]; then
      warn "$prefix/manifest.json names no payload; building $name"
      continue
    fi
    get "$prefix/$payload" "$SCRATCH/payload.tar.gz" || {
      warn "$prefix has a manifest and no payload; building $name"
      continue
    }
    if [[ "$(sha256 <"$SCRATCH/payload.tar.gz")" != "$sha" ]]; then
      warn "$prefix/$payload does not hash to its name; building $name"
      continue
    fi
    if ! members_are_outputs "$SCRATCH/payload.tar.gz"; then
      warn "$prefix/$payload holds files outside $name's outputs; building $name"
      continue
    fi
    remove_outputs
    tar -xzf "$SCRATCH/payload.tar.gz" --no-same-owner
    if ! verify; then
      warn "$prefix does not match the pins; building $name"
      remove_outputs
      continue
    fi
    note "$name: restored from $scope/ ($key)"
    printf 'hit\n' >"$state/$name"
    summary "$name: restored from \`$scope/\`"
    return 0
  done
  note "$name: not cached ($key)"
  return 1
}

# store_one <name> <key>: stores the outputs under the key, when this run
# writes a scope.
store_one() {
  local name="$1" key="$2" payload sha bytes prefix commit run
  enabled || return 0
  scopes
  if [[ -z "$WRITE" ]]; then
    note "$name: this run stores nothing"
    return 0
  fi
  outputs
  payload="$SCRATCH/payload.tar.gz"
  # The same bytes for the same files: names sorted, owners and the gzip
  # header's time left out.
  tar --sort=name --owner=0 --group=0 --numeric-owner -cf - "${OUTPUT_PATHS[@]}" | gzip -n >"$payload"
  sha="$(sha256 <"$payload")"
  bytes="$(wc -c <"$payload" | tr -d ' ')"
  prefix="build-cache/$WRITE/$name/$key"
  commit="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
  run=""
  [[ -z "${GITHUB_RUN_ID:-}" ]] || run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  inputs "$name" >"$SCRATCH/inputs.txt"
  if [[ "$(sha256 <"$SCRATCH/inputs.txt")" != "$key" ]]; then
    warn "$name's inputs changed while it built, so it is not stored; its build writes into what it is built from"
    return 0
  fi
  cat >"$SCRATCH/manifest.json" <<JSON
{
  "schema": 1,
  "name": "$name",
  "key": "$key",
  "payload": "payload-$sha.tar.gz",
  "payload_bytes": $bytes,
  "outputs": "${OUTPUT_PATHS[*]}",
  "commit": "$commit",
  "ref": "${GITHUB_REF:-}",
  "run": "$run",
  "stored": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  # The manifest last: until it is there, the entry is a miss.
  if ! put "$payload" "$prefix/payload-$sha.tar.gz" || ! put "$SCRATCH/inputs.txt" "$prefix/inputs.txt" ||
    ! put "$SCRATCH/manifest.json" "$prefix/manifest.json"; then
    warn "could not store $name in $WRITE/; the next run builds it again"
    return 0
  fi
  note "$name: stored in $WRITE/ ($key, $bytes bytes)"
  summary "$name: built and stored in \`$WRITE/\`"
}

summary() {
  [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf -- '- %s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
}

build_one() {
  local name="$1" result key
  if [[ ! -f "$state/$name" ]]; then
    fetch_one "$name" || true
  fi
  read -r result key <"$state/$name"
  if [[ "$result" == hit ]]; then
    note "$name: restored, not built"
    return 0
  fi
  spec "$name"
  note "$name: building (${BUILD[*]})"
  # Without the bucket's credentials: the build runs third-party code
  # (CMake files, Cargo build scripts, Go modules).
  env -u IWCI_R2_ACCOUNT_ID -u IWCI_R2_BUCKET -u IWCI_R2_ACCESS_KEY_ID -u IWCI_R2_SECRET_ACCESS_KEY "${BUILD[@]}"
  outputs
  store_one "$name" "$key"
  printf 'hit\n' >"$state/$name"
}

if [[ $# -lt 2 ]]; then
  echo "usage: build-cache.sh fetch|build|store|key <name>..." >&2
  exit 2
fi
command="$1"
shift
case "$command" in
  fetch)
    all=true
    for name in "$@"; do
      fetch_one "$name" || all=false
    done
    if [[ $# -eq 1 && -n "${GITHUB_OUTPUT:-}" ]]; then
      echo "hit=$all" >>"$GITHUB_OUTPUT"
    fi
    ;;
  build)
    for name in "$@"; do
      build_one "$name"
    done
    ;;
  store)
    for name in "$@"; do
      spec "$name"
      outputs
      verify
      store_one "$name" "$(key_of "$name")"
    done
    ;;
  key)
    for name in "$@"; do
      spec "$name"
      inputs "$name" >"$SCRATCH/inputs.txt"
      echo "$name $(sha256 <"$SCRATCH/inputs.txt")"
      sed 's/^/  /' "$SCRATCH/inputs.txt"
    done
    ;;
  *)
    echo "usage: build-cache.sh fetch|build|store|key <name>..." >&2
    exit 2
    ;;
esac
