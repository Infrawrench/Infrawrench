#!/usr/bin/env bash
# `iwci/pglite-server`, the package `env:postgres` adds to Wasmer's pglite:
#
#   pglite-server  many client connections over pglite's one (*.go here;
#                  server.go says what a client gets), compiled for WASIX
#   share/         extensions pglite lacks, found through
#                  extension_control_path: a pgcrypto with its digest, hmac
#                  and gen_random_bytes (pglite has no OpenSSL)
#
# The program is Go, built for wasip1 by the same patched Go as `env:go@1.27`
# (go/build.sh: Go's release archive for this host, checked against the
# sha256 go.dev publishes, with go/1.27's series applied), whose `net` and
# `os/exec` are WASIX's sockets and processes. Its tests run first, natively.
# `-trimpath`, no VCS stamp (inside a git checkout Go would record the
# commit and whether the tree is clean) and an empty build id keep this
# machine and checkout out of the module, and every file of the package gets
# the same time stamp, so the package comes out byte for byte the same on
# x86_64 and ARM64; environments/build.sh pins its hash like any other
# package's.
#
#   environments/pglite-server/build.sh
#     -> dist/package/pglite-server/<version>/pglite-server.webc
#
# Needs: curl, git (to apply the series), sha256sum, tar, find, touch; Linux
# on x86_64 or arm64.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The package's own version: a change to anything here is a new one.
VERSION="1.0.0"
BUILT_ON=946684800 # 2000-01-01T00:00:00Z

# The Go release and its archives' hashes, as go/build.sh pins them.
GO_MINOR=1.27
read -r go_version amd64_sha arm64_sha _ <<<"$(sed -n "s/^    $GO_MINOR) echo \"\(.*\)\" ;;\$/\1/p" "$here/environments/go/build.sh")"
if [[ -z "$go_version" ]]; then
  echo "error: no Go $GO_MINOR in environments/go/build.sh" >&2
  exit 1
fi

# The Wasmer CLI, only to build the package (go/build.sh's release).
WASMER_VERSION="v7.4.2"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    arch=amd64 go_sha="$amd64_sha" wasmer_arch=amd64
    wasmer_sha="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
    ;;
  Linux-aarch64 | Linux-arm64)
    arch=arm64 go_sha="$arm64_sha" wasmer_arch=aarch64
    wasmer_sha="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"
    ;;
  *)
    echo "error: pglite-server builds on Linux, x86_64 or arm64" >&2
    exit 1
    ;;
esac

work="$SCRATCH/pglite-server"
mkdir -p "$work/dl"

# download <url> <sha256> <file>
download() {
  local url="$1" sha="$2" file="$work/dl/$3"
  curl -fsSL --retry 3 -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    exit 1
  fi
  printf '%s\n' "$file"
}

goroot="$work/go"
mkdir -p "$goroot" "$work/wasmer"
tar -xzf "$(download "https://go.dev/dl/go$go_version.linux-$arch.tar.gz" "$go_sha" go.tar.gz)" -C "$goroot" --strip-components=1
for patch in "$here/environments/go/$GO_MINOR"/*.patch; do
  git -C "$goroot" apply --whitespace=nowarn "$patch"
done
tar -xzf "$(download "https://github.com/wasmerio/wasmer/releases/download/$WASMER_VERSION/wasmer-linux-$wasmer_arch.tar.gz" \
  "$wasmer_sha" wasmer.tar.gz)" -C "$work/wasmer"

# clean <command>: the patched toolchain's environment, with nothing from
# this machine's configuration. GOOS and GOARCH are the caller's.
clean() {
  env -i PATH="$goroot/bin:/usr/bin:/bin" HOME="$work/home" GOROOT="$goroot" \
    GOENV=off GOFLAGS= GOTOOLCHAIN=local GOPROXY=off GOTELEMETRY=off CGO_ENABLED=0 \
    GOCACHE="$work/cache" "$@"
}

package="$work/package"
mkdir -p "$package/modules"
cp -R "$self/share" "$package/share"
(cd "$self" && clean "$goroot/bin/go" test -count=1 ./...)
(cd "$self" && clean GOOS=wasip1 GOARCH=wasm "$goroot/bin/go" build -trimpath -buildvcs=false -ldflags=-buildid= \
  -o "$package/modules/pglite-server" .)

cat >"$package/wasmer.toml" <<TOML
[package]
name = "iwci/pglite-server"
version = "$VERSION"
description = "Many PostgreSQL connections over wasmer/pglite's one, and a pgcrypto for it"

[fs]
"/opt/pglite-server" = "share"

[[module]]
name = "pglite-server"
source = "modules/pglite-server"
abi = "wasi"

[[command]]
name = "pglite-server"
module = "pglite-server"
runner = "wasi"
TOML
find "$package" -type d -exec chmod 0755 {} +
find "$package" -type f -exec chmod 0644 {} +
find "$package" -exec touch -h -d "@$BUILT_ON" {} +

out="$(out_dir package pglite-server "$VERSION")"
WASMER_DIR="$work/wasmer-home" "$work/wasmer/bin/wasmer" package build --quiet -o "$out/pglite-server.webc" "$package"
echo "built $out/pglite-server.webc"
echo "  module  $(sha256sum "$package/modules/pglite-server" | cut -d' ' -f1)"
echo "  package $(sha256sum "$out/pglite-server.webc" | cut -d' ' -f1)"
