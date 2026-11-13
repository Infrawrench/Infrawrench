#!/usr/bin/env bash
# `iwci/clickhouse`, the package `env:clickhouse` adds to bash-node's:
# ClickHouse 26.11 as a service for a job (`services:`), at /opt/clickhouse.
#
#   lib/clickhouse-ci.{mjs,wasm}  CloudHouse (Infrawrench's fork of ClickHouse)
#                                 built for one-thread WebAssembly as its
#                                 `clickhouse-ci` target: an Emscripten
#                                 module with a query function, no server
#   lib/server.mjs                ClickHouse's HTTP interface on Node (Edge.js
#                                 in a job) in front of it
#   bin/clickhouse-server         `node /opt/clickhouse/lib/server.mjs`
#
# CloudHouse's `-DWASM_ISOLATE=1` build is the engine of its Cloudflare
# Workers deployment: wasm64, native WebAssembly exceptions, one thread, no
# sockets. Its `clickhouse-isolate` target is sized for a 128 MB Worker and
# registers a short list (no `ReplacingMergeTree`, no materialized views) and
# needs JSPI, which the runner's V8 13.6 has only behind a flag.
# cloudhouse-ci.patch adds the `clickhouse-ci` target over the same objects:
# what clickhouse-local registers, every system table of a server, no JSPI,
# memory for a job. It is kept here, as ci-runner/vendor/ keeps its patches,
# rather than in CloudHouse; it applies to the commit pinned below, and a
# CloudHouse bump that it no longer applies to fails here.
#
# What the engine cannot do, because it has one thread: background merges,
# mutations and TTL never run (`FINAL` and `OPTIMIZE ... FINAL` work, in the
# query; mutations apply when read, `apply_mutations_on_fly`), and there is
# no asynchronous insert queue (an `async_insert` insert is synchronous, and
# server.mjs answers `SYSTEM FLUSH ASYNC INSERT QUEUE` without the engine).
# Everything is in memory. The README's "ClickHouse" section has the rest.
#
# Pinned: CloudHouse's commit, and through it every submodule's; emsdk's
# commit and the SDK release it installs; CMake's and Ninja's release
# archives, by sha256; and the Wasmer CLI that packages it. The host compiler only builds `flatc`
# (Arrow's schema compiler, which runs during the build), whose output is
# source code. The build runs at a fixed path, $root below, because paths
# reach the module (`__FILE__` outside the source tree, which
# `-ffile-prefix-map` does not cover); with that, the package comes out byte
# for byte the same wherever it is built, and environments/build.sh pins its
# hash like any other package's.
#
#   environments/clickhouse/build.sh
#     -> dist/package/clickhouse/<version>/clickhouse.webc
#
# About 6,900 objects: two to three hours on four cores. CLICKHOUSE_JOBS
# sets Ninja's parallelism (default: the CPUs; each compile can take a
# GiB or more). KEEP_BUILD=1 leaves $root, to rebuild after a change to the
# patch in minutes rather than hours.
#
# Needs: curl, git, python3 (emsdk is Python), sha256sum, tar, a host C++
# compiler (CXX, default c++); Linux on x86_64 or ARM64.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The package's own version: ClickHouse's, then ours. A change to anything
# here is a new one.
VERSION="26.11.1-iwci.1"
BUILT_ON=946684800 # 2000-01-01T00:00:00Z

CLOUDHOUSE_URL="https://github.com/Infrawrench/CloudHouse.git"
CLOUDHOUSE_COMMIT="beda206b770e2ab46d6815e614ff688b513a3edd"
# The submodules the build reads (of CloudHouse's 159). Each is fetched at
# the commit CloudHouse's tree records for it. Two only in part, by their
# paths in SPARSE: llvm-project for compiler-rt's headers
# (`sanitizer/asan_interface.h`) and libFuzzer's sources (which
# contrib/libfuzzer-cmake declares, though nothing builds them), and sysroot (the Linux sysroots) for the
# README that CloudHouse's CMakeLists.txt checks for.
SUBMODULES=(
  abseil-cpp arrow avro boost brotli bzip2 c-ares cctz clickstack crc32c
  croaring double-conversion fast_float flatbuffers fmtlib gdeflate grpc heks
  ipcrypt2 libarchive libdivide libfiu libhdfs3 libuv libxml2 llvm-project lz4
  magic_enum miniselect morton-nd msgpack-c openssl rapidjson re2 replxx
  SHA3IUF simdutf snappy sparsehash-c11 sql-console StringZilla thrift wyhash
  xsimd xxHash xz zlib-ng zmij zstd zxc sysroot
)
declare -A SPARSE=(
  [llvm-project]="/compiler-rt/include/ /compiler-rt/lib/fuzzer/"
  [sysroot]="/README.md"
)

# emsdk's tag 6.0.5, and the SDK release it installs.
EMSDK_URL="https://github.com/emscripten-core/emsdk.git"
EMSDK_COMMIT="dfb9d1a46c3bb8f52e1e6324be23123b9d73c190"
EMSDK_VERSION="6.0.5"
CMAKE_VERSION="4.0.3"
NINJA_VERSION="1.13.0"

# The Wasmer CLI, only to build the package (pglite-server's release).
WASMER_VERSION="v7.4.2"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    wasmer_arch=amd64
    wasmer_sha="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
    cmake_arch=x86_64
    cmake_sha="585ae9e013107bc8e7c7c9ce872cbdcbdff569e675b07ef57aacfb88c886faac"
    ninja_zip=ninja-linux.zip
    ninja_sha="46aa8ad0a431e9b6e39f6ca0abc47bf8b13be094e3ac7d0f6d39e94bbdc746f9"
    ;;
  Linux-aarch64 | Linux-arm64)
    wasmer_arch=aarch64
    wasmer_sha="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"
    cmake_arch=aarch64
    cmake_sha="391da1544ef50ac31300841caaf11db4de3976cdc4468643272e44b3f4644713"
    ninja_zip=ninja-linux-aarch64.zip
    ninja_sha="b2b2f956963ef6300841c253a7aa81c3e9e5dbd2ed059bee6f8bcd851b5bb096"
    ;;
  *)
    echo "error: clickhouse builds on Linux, x86_64 or ARM64" >&2
    exit 1
    ;;
esac

root=/tmp/iwci-clickhouse
src="$root/ClickHouse"
build="$src/build_wasm_ci"
rm -rf "$root"
mkdir -p "$root"
if [[ "${KEEP_BUILD:-}" != 1 ]]; then
  trap 'rm -rf "$SCRATCH" "$root"' EXIT
fi

# download <url> <sha256> <file>
download() {
  local url="$1" sha="$2" file="$root/dl/$3"
  mkdir -p "$root/dl"
  curl -fsSL --retry 3 -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    exit 1
  fi
  printf '%s\n' "$file"
}

# fetch_commit <dir> <url> <commit> [sparse paths]: that one commit, shallow,
# and only the paths given (space separated), if any.
fetch_commit() {
  local dir="$1" url="$2" commit="$3" sparse="${4:-}"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  if [[ -n "$sparse" ]]; then
    # shellcheck disable=SC2086 # One argument per path.
    git -C "$dir" sparse-checkout set --no-cone $sparse
    git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$commit"
  else
    git -C "$dir" fetch -q --depth 1 origin "$commit"
  fi
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
}

echo "clickhouse: emsdk $EMSDK_VERSION, CMake $CMAKE_VERSION, Ninja $NINJA_VERSION"
fetch_commit "$root/emsdk" "$EMSDK_URL" "$EMSDK_COMMIT"
"$root/emsdk/emsdk" install "$EMSDK_VERSION" >/dev/null
"$root/emsdk/emsdk" activate "$EMSDK_VERSION" >/dev/null
mkdir -p "$root/tools/bin"
tar -xzf "$(download "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-$cmake_arch.tar.gz" \
  "$cmake_sha" cmake.tar.gz)" -C "$root/tools" --strip-components=1
python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
  "$(download "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/$ninja_zip" "$ninja_sha" ninja.zip)" "$root/tools/bin"
chmod 0755 "$root/tools/bin/ninja"

echo "clickhouse: CloudHouse $CLOUDHOUSE_COMMIT and ${#SUBMODULES[@]} submodules"
fetch_commit "$src" "$CLOUDHOUSE_URL" "$CLOUDHOUSE_COMMIT"
for name in "${SUBMODULES[@]}"; do
  path="contrib/$name"
  url="$(git -C "$src" config -f .gitmodules "submodule.$path.url")"
  commit="$(git -C "$src" ls-tree HEAD "$path" | awk '$2 == "commit" { print $3 }')"
  if [[ -z "$url" || -z "$commit" ]]; then
    echo "error: CloudHouse has no submodule $path" >&2
    exit 1
  fi
  if [[ -n "${SPARSE[$name]:-}" ]]; then
    fetch_commit "$src/$path" "$url" "$commit" "${SPARSE[$name]}"
  else
    fetch_commit "$src/$path" "$url" "$commit"
    # As CloudHouse's contrib/update-submodules.sh does: the build uses its
    # own CMake files for third-party code, never theirs.
    find "$src/$path" '(' -name CMakeLists.txt -or -name '*.cmake' ')' -and -not -name '*.h.cmake' -delete
  fi
done
git -C "$src" apply "$self/cloudhouse-ci.patch"

# Arrow's build runs `flatc`, which has to run here: built with the host
# compiler from the sources contrib/flatbuffers-cmake lists.
echo "clickhouse: flatc"
flatc_sources=()
# shellcheck disable=SC2016 # `${LIBRARY_DIR}` is CMake's, matched literally.
while IFS= read -r file; do
  flatc_sources+=("$file")
done < <(sed -n '/^set(FLATBUFFERS_SRCS$/,/)/p; /^set(FLATC_SRCS$/,/)/p' "$src/contrib/flatbuffers-cmake/CMakeLists.txt" |
  sed -n 's#^ *\${LIBRARY_DIR}/\([^ )]*\).*#contrib/flatbuffers/\1#p')
if [[ ${#flatc_sources[@]} -lt 20 ]]; then
  echo "error: found only ${#flatc_sources[@]} sources of flatc in contrib/flatbuffers-cmake/CMakeLists.txt" >&2
  exit 1
fi
mkdir -p "$root/flatc"
(cd "$src" && "${CXX:-c++}" -std=c++17 -O2 -DFLATBUFFERS_LOCALE_INDEPENDENT=0 -Icontrib/flatbuffers/include \
  -Icontrib/flatbuffers -Icontrib/flatbuffers/grpc -o "$root/flatc/flatc" "${flatc_sources[@]}")

# As CloudHouse's serverless/README.md configures the isolate build.
echo "clickhouse: configuring"
(
  # shellcheck disable=SC1091
  source "$root/emsdk/emsdk_env.sh" >/dev/null 2>&1
  export PATH="$root/tools/bin:$PATH"
  emcmake cmake -S "$src" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=MinSizeRel \
    "-DCMAKE_C_FLAGS_MINSIZEREL=-Oz -DNDEBUG" "-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG" \
    -DWASM_ISOLATE=1 -DENABLE_LIBRARIES=0 -DENABLE_THINLTO=0 -DSANITIZE= -DENABLE_TESTS=0 \
    -DENABLE_UTILS=0 -DENABLE_CLICKHOUSE_ALL=0 -DCOMPILER_CACHE=disabled \
    -DENABLE_SIMDUTF=1 -DENABLE_AVRO=1 -DENABLE_MSGPACK=1 -DENABLE_SNAPPY=1 -DENABLE_THRIFT=1 \
    -DENABLE_BROTLI=1 -DENABLE_BZIP2=1 -DENABLE_RAPIDJSON=1 -DENABLE_PARQUET=1 \
    "-DHOST_FLATC=$root/flatc/flatc" >"$root/configure.log" 2>&1 || {
    tail -50 "$root/configure.log" >&2
    exit 1
  }
  echo "clickhouse: building clickhouse-ci (log in $root/build.log)"
  ninja -C "$build" -j "${CLICKHOUSE_JOBS:-$(nproc)}" clickhouse-ci >"$root/build.log" 2>&1 || {
    grep -B2 -A20 -m5 'FAILED:' "$root/build.log" >&2 || tail -50 "$root/build.log" >&2
    exit 1
  }
)

# shellcheck disable=SC2031 # lib.sh sets SCRATCH; the subshell above only reads it.
work="$SCRATCH/clickhouse"
mkdir -p "$work/wasmer"
tar -xzf "$(download "https://github.com/wasmerio/wasmer/releases/download/$WASMER_VERSION/wasmer-linux-$wasmer_arch.tar.gz" \
  "$wasmer_sha" wasmer.tar.gz)" -C "$work/wasmer"

package="$work/package"
mkdir -p "$package/fs/bin" "$package/fs/lib"
cp "$build/programs/isolate/clickhouse-ci.mjs" "$build/programs/isolate/clickhouse-ci.wasm" "$self/server.mjs" "$package/fs/lib/"
cat >"$package/fs/bin/clickhouse-server" <<'SH'
#!/bin/bash
exec node /opt/clickhouse/lib/server.mjs "$@"
SH
cat >"$package/wasmer.toml" <<TOML
[package]
name = "iwci/clickhouse"
version = "$VERSION"
description = "ClickHouse 26.11 (CloudHouse) for one-thread WebAssembly, served over ClickHouse's HTTP interface by Node"

[fs]
"/opt/clickhouse" = "fs"
TOML
find "$package" -type d -exec chmod 0755 {} +
find "$package" -type f -exec chmod 0644 {} +
chmod 0755 "$package/fs/bin/clickhouse-server"
find "$package" -exec touch -h -d "@$BUILT_ON" {} +

out="$(out_dir package clickhouse "$VERSION")"
WASMER_DIR="$work/wasmer-home" "$work/wasmer/bin/wasmer" package build --quiet -o "$out/clickhouse.webc" "$package"
echo "built $out/clickhouse.webc"
echo "  package $(sha256sum "$out/clickhouse.webc" | cut -d' ' -f1)"
echo "  module  $(sha256sum "$package/fs/lib/clickhouse-ci.wasm" | cut -d' ' -f1)"
