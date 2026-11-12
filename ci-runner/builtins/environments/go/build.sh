#!/usr/bin/env bash
# The Go toolchain for `env:go`, built from source for WASIX. Upstream Go's
# `wasip1` port cannot host itself: it has no subprocesses (`go build` runs
# `compile` and `link` as children) and no real sockets. wasix-org/go's
# `wasix` branch (Wasmer's, published as `golang/go` 1.25.5-wasix-1) keeps
# GOOS=wasip1 and gives `syscall`, `os/exec` and `net` WASIX's processes and
# sockets; programs the toolchain builds get them too. That branch is one
# Go release and, as published, does not run (README.md, "Go"). Each
# directory here is a patch series for one Go minor release: the branch's
# change ported to that release, then our fixes, one patch each, written as
# commits whose messages say what they fix (`git am` takes them as they
# are). A patch that names an upstream issue can go once a release has it.
#
#   build.sh <minor>   build the package for that minor (1.23 ... 1.27)
#
# The steps, each pinned:
#
#   1. Go's own release archive for this host (`go<version>.linux-<arch>`),
#      checked against the sha256 go.dev publishes. Its `src/` is the source
#      the series applies to, and its native toolchain is the compiler: the
#      series changes no compiler, so the native one builds the patched
#      sources for wasip1 exactly as a wasip1 one would.
#   2. The tests and `testdata` removed from `src/` (nothing in a job needs
#      them, and with them the package is over the store's 256 MiB per-file
#      limit), then `go`, `gofmt` and the tools the release ships in
#      `pkg/tool` built for wasip1 with `-trimpath`, so no path of this
#      machine is in them and the same inputs give the same bytes anywhere.
#      Not the tools that read binaries and profiles (pprof, trace, objdump,
#      nm, addr2line), which Go 1.25 stopped shipping as well: 1.23 and 1.24
#      are over the limit with them.
#   3. A build cache of the standard library, made by the native toolchain
#      for wasip1. The go command keys its cache by what goes into a
#      compile, which for the standard library is the sources, the target,
#      the flags and the compiler's version line, never where the compiler
#      runs or what it is compiled for, so the wasm `go` finds these entries
#      and a job's first `go build` does not compile `runtime`, `fmt` and the
#      rest from source (40 seconds on one CPU). It covers `go build`, `go
#      vet` (the facts its analyzers keep for each dependency) and the vet
#      `go test` runs, for every package of the standard library.
#   4. Mozilla's CA certificates as curl.se publishes them, for TLS.
#
# Everything is laid out as two Wasmer packages (`wasmer package build`,
# from the Wasmer CLI release pinned below), the toolchain and the cache,
# which together are over the limit for one file, with every time stamp
# fixed, so the build is reproducible: `environments/build.sh` checks both
# against the hashes it pins, and a build that comes out different fails
# there. They go to dist/package/go/<version>/{go,go-std-cache}.webc.
#
# Linux on x86_64 or arm64 (the pinned Go and Wasmer archives are those
# platforms'). A minute or two and about 2 GB of disk per minor. GO_WORK
# keeps the downloads somewhere of your choosing (default: a scratch
# directory removed on exit).
#
# Needs: bash, curl, git (to apply the series), sha256sum, tar, find, touch.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# minor: Go release, then the sha256 of its linux-amd64 and linux-arm64
# archives (https://go.dev/dl/?mode=json&include=all), then our build of it:
# a changed build of the same release is a new number after `iwci.`.
release() {
  case "$1" in
    1.23) echo "1.23.12 d3847fef834e9db11bf64e3fb34db9c04db14e068eeb064f49af747010454f90 52ce172f96e21da53b1ae9079808560d49b02ac86cecfa457217597f9bc28ab3 1" ;;
    1.24) echo "1.24.13 1fc94b57134d51669c72173ad5d49fd62afb0f1db9bf3f798fd98ee423f8d730 74d97be1cc3a474129590c67ebf748a96e72d9f3a2b6fef3ed3275de591d49b3 1" ;;
    1.25) echo "1.25.14 a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712 9bf234ea70ffec9347fdf6b22ce4add51717d3386a38a441e8c8743fceb5eaee 1" ;;
    1.26) echo "1.26.11 9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec 6c2f29b458b5add0835f18b776f69c8881a6d88428f1484a6da55755e620757e 1" ;;
    1.27) echo "1.27.4 7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840 3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92 1" ;;
    *)
      echo "error: no Go $1 here; know 1.23 to 1.27" >&2
      exit 2
      ;;
  esac
}

# Mozilla's CA certificates, as extracted by curl.se on that date.
CACERT_URL="https://curl.se/ca/cacert-2026-11-05.pem"
CACERT_SHA256="427c064216761a1e72a8b30f0d954d08cb6e4435a82091fb865afd20c8497285"

# The Wasmer CLI, only to build the package.
WASMER_VERSION="v7.4.2"
WASMER_AMD64_SHA256="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
WASMER_ARM64_SHA256="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"

# Every file in the package is stamped with this time: the release's own
# date from its VERSION file would do as well, but one fixed value keeps the
# build cache's entries (below) the same whatever the release.
BUILT_ON=946684800 # 2000-01-01T00:00:00Z
# The cache's files are stamped far in the future instead. The go command
# rewrites the time of any entry it uses whose time is over an hour old,
# which in a job would copy each one out of the package, and drops entries
# five days unused when it trims; neither ever applies to a future time.
CACHE_TIME=4102444800 # 2100-01-01T00:00:00Z

if [[ $# -ne 1 ]]; then
  echo "usage: build.sh <minor>   (1.23 to 1.27)" >&2
  exit 2
fi
minor="$1"
read -r go_version amd64_sha arm64_sha build <<<"$(release "$minor")"
series="$self/$minor"
version="$go_version-iwci.$build"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=amd64 go_sha="$amd64_sha" wasmer_arch=amd64 wasmer_sha="$WASMER_AMD64_SHA256" ;;
  Linux-aarch64 | Linux-arm64) arch=arm64 go_sha="$arm64_sha" wasmer_arch=aarch64 wasmer_sha="$WASMER_ARM64_SHA256" ;;
  *)
    echo "error: Go for WASIX builds on Linux, x86_64 or arm64" >&2
    exit 1
    ;;
esac

work="${GO_WORK:-$SCRATCH/go}"
mkdir -p "$work/dl"

# download <url> <sha256> <file>: fetched once, checked every time.
download() {
  local url="$1" sha="$2" file="$work/dl/$3"
  [[ -f "$file" ]] || curl -fsSL --retry 3 -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    rm -f "$file"
    exit 1
  fi
  printf '%s\n' "$file"
}

wasmer="$work/wasmer-$WASMER_VERSION"
if [[ ! -x "$wasmer/bin/wasmer" ]]; then
  mkdir -p "$wasmer"
  tar -xzf "$(download "https://github.com/wasmerio/wasmer/releases/download/$WASMER_VERSION/wasmer-linux-$wasmer_arch.tar.gz" \
    "$wasmer_sha" "wasmer-$WASMER_VERSION-$wasmer_arch.tar.gz")" -C "$wasmer"
fi

# 1. The release, and the series applied to its source.
goroot="$work/go$go_version"
rm -rf "$goroot"
mkdir -p "$goroot"
tar -xzf "$(download "https://go.dev/dl/go$go_version.linux-$arch.tar.gz" "$go_sha" "go$go_version.linux-$arch.tar.gz")" \
  -C "$goroot" --strip-components=1
if [[ "$(head -n 1 "$goroot/VERSION")" != "go$go_version" ]]; then
  echo "error: the archive is $(head -n 1 "$goroot/VERSION"), not go$go_version" >&2
  exit 1
fi
for patch in "$series"/*.patch; do
  git -C "$goroot" apply --whitespace=nowarn "$patch" || {
    echo "error: $(basename "$patch") does not apply to go$go_version" >&2
    exit 1
  }
done

# 2. Without tests, then the toolchain for wasip1.
find "$goroot/src" -name testdata -type d -prune -exec rm -rf {} +
find "$goroot/src" \( -name '*_test.go' -o -name '*_test.s' \) -type f -delete
# The native go command, on its own release, with nothing from this
# machine's configuration.
hostgo() {
  env -i PATH="$goroot/bin:/usr/bin:/bin" HOME="$work/home" GOROOT="$goroot" \
    GOENV=off GOFLAGS= GOTOOLCHAIN=local GOPROXY=off GOTELEMETRY=off CGO_ENABLED=0 \
    GOCACHE="$work/cache-$1" GOOS=wasip1 GOARCH=wasm "${@:2}"
}
rm -rf "${work:?}/cache-tools" "${work:?}/cache-std" "${work:?}/home"
out_root="$work/package"
rm -rf "$out_root"
mkdir -p "$out_root/modules" "$out_root/go/pkg/tool/wasip1_wasm"
(cd "$goroot/src" && hostgo tools "$goroot/bin/go" build -trimpath -o "$out_root/modules/" cmd/go cmd/gofmt)
# The tools the release ships, but for the ones that read binaries and
# profiles, which Go 1.25 stopped shipping too (`go tool` builds them when
# run there): 1.23 and 1.24 are over the size limit with them.
tools=()
for tool in "$goroot/pkg/tool/linux_$arch"/*; do
  case "$(basename "$tool")" in
    addr2line | nm | objdump | pprof | trace) ;;
    *) tools+=("cmd/$(basename "$tool")") ;;
  esac
done
(cd "$goroot/src" && hostgo tools "$goroot/bin/go" build -trimpath -o "$out_root/go/pkg/tool/wasip1_wasm/" "${tools[@]}")

# 3. The standard library's build cache: what `go build`, `go vet` and the
#    vet `go test` runs (with flags of its own) record for each package. The
#    tests are gone, so `go test std` runs nothing and only vets.
(cd "$goroot/src" && hostgo std "$goroot/bin/go" build std)
(cd "$goroot/src" && hostgo std "$goroot/bin/go" vet std)
(cd "$goroot/src" && hostgo std "$goroot/bin/go" test -count=1 std >/dev/null)
cache_root="$work/package-cache"
rm -rf "$cache_root"
mkdir -p "$cache_root"
cache="$cache_root/cache"
cp -a "$work/cache-std" "$cache"
# Each entry is an action file `<id>-a` naming an output `<hash>-d`, and
# records when it was made: fix that, and never trim. The go command also
# keeps an index of each package directory it reads, keyed by the path of
# GOROOT on this machine: of no use where GOROOT is /go, and different on
# every machine, so those go.
find "$cache" -name '*-a' -type f | sort | while read -r entry; do
  read -r v action output size _ <"$entry"
  data="$cache/${output:0:2}/$output-d"
  if [[ "$(head -c 10 "$data" 2>/dev/null | tr -d '\0')" == "go index v" ]]; then
    rm -f "$entry" "$data"
    continue
  fi
  printf '%s %s %s %20s %20d\n' "$v" "$action" "$output" "$size" $((CACHE_TIME * 1000000000)) >"$entry"
done
echo "$CACHE_TIME" >"$cache/trim.txt"

# The tree a job sees as GOROOT.
for f in VERSION go.env LICENSE PATENTS; do cp "$goroot/$f" "$out_root/go/"; done
cp -a "$goroot/src" "$goroot/lib" "$out_root/go/"
mkdir -p "$out_root/go/pkg"
cp -a "$goroot/pkg/include" "$out_root/go/pkg/"

# 4. The CA certificates.
mkdir -p "$out_root/certs"
cp "$(download "$CACERT_URL" "$CACERT_SHA256" cacert.pem)" "$out_root/certs/ca-certificates.crt"

cat >"$out_root/wasmer.toml" <<TOML
[package]
name = "iwci/go"
version = "$version"
description = "Go $go_version for WASIX, built by builtins/environments/go/build.sh"
license = "BSD-3-Clause"

[fs]
"/go" = "go"
"/etc/ssl/certs" = "certs"

[[module]]
name = "go"
source = "modules/go"
abi = "wasi"

[[module]]
name = "gofmt"
source = "modules/gofmt"
abi = "wasi"

[[command]]
name = "go"
module = "go"
runner = "wasi"

[[command]]
name = "gofmt"
module = "gofmt"
runner = "wasi"
TOML

# The cache is a package of its own: the two together are over the store's
# 256 MiB limit for one file.
cat >"$cache_root/wasmer.toml" <<TOML
[package]
name = "iwci/go-std-cache"
version = "$version"
description = "The standard library of Go $go_version for WASIX, compiled and vetted, as GOCACHE entries"
license = "BSD-3-Clause"

[fs]
"/root/.cache/go-build" = "cache"
TOML

find "$out_root" "$cache_root" -exec touch -h -d "@$BUILT_ON" {} +
find "$cache" -exec touch -h -d "@$CACHE_TIME" {} +
out="$(out_dir package go "$version")"
export WASMER_DIR="$work/wasmer-home"
"$wasmer/bin/wasmer" package build --quiet -o "$out/go.webc" "$out_root"
"$wasmer/bin/wasmer" package build --quiet -o "$out/go-std-cache.webc" "$cache_root"

echo "built $out"
for webc in go go-std-cache; do
  size="$(stat -c %s "$out/$webc.webc")"
  echo "  $webc.webc $(sha256sum "$out/$webc.webc" | cut -d' ' -f1) ($((size >> 20)) MiB)"
  # The store's limit for one file, which a publish would hit later.
  if ((size > 256 << 20)); then
    echo "error: $webc.webc is over the store's 256 MiB limit for one file" >&2
    exit 1
  fi
done
