#!/usr/bin/env bash
# Edge.js for `env:bash-node`, built from source on a wasix-libc with two
# races fixed that no release of it, and so no release of Edge.js, has fixed,
# and with one fix to Edge.js itself.
#
# The C library is linked into Edge.js's module, so a fix to it is a rebuild
# of that module. Each is one patch here and one object of `libc.a`:
#
#   wasix-libc-145.patch (chdir.o, #937). wasix-libc made a relative path
#     absolute in one static buffer that every thread shares, so two `fs`
#     calls on libuv's thread pool could trade paths: a read opened the
#     working directory (EISDIR) or another file. The patch is
#     wasix-org/wasix-libc#145 as written upstream, where it is still open.
#
#   wasix-libc-thread-exit.patch (pthread_create.o, #967). A thread that
#     exits releases the thread-list lock itself, which lets `pthread_join`
#     free its stack, and then made one more host call (`futex_wake`, to wake
#     whoever waits for the lock) that writes its result into that stack. By
#     then another `pthread_create` could have been handed the block, so one
#     byte of a starting thread's stack, start arguments or thread structure
#     was overwritten: under thread churn a `node` now and then lost a thread
#     to a trap in its first instructions. The patch is ours, reported as
#     wasix-org/wasix-libc#146: the result of that last call goes to static
#     storage. Drop it once a sysroot carries a fix for that issue.
#
# And one patch to Edge.js's own source, applied to its checkout:
#
#   edgejs-worker-stop.patch (#938). Edge.js stops a Worker by terminating
#     its isolate from the parent's thread and setting a flag its loop
#     checks between turns, but V8 lifts a termination once it has unwound
#     the JavaScript that was running, and the worker's port went on to
#     dispatch the next queued message in the same turn. Its handler ran
#     normally, and one that blocked in `Atomics.wait` (rolldown's idle wasm
#     threads) blocked for good while the parent waited in `pthread_join`:
#     about one tsdown bundle in 300 to 600 never exited. The patch drops a
#     stopped worker's queued messages instead, as Node does once it cannot
#     call into JavaScript. Ours (nothing upstream yet).
#
# This builds exactly what `wasmer/edgejs` 0.2.5 was built from, with those
# two objects of the C library replaced and that patch applied:
#
#   1. The sysroot 0.2.5 was built on (wasix-libc v2026-07-30.1), with the
#      two objects in its `libc.a` recompiled from that tag's source plus the
#      patches, using wasix-libc's own Makefile so the flags are its own.
#   2. Edge.js at the commit 0.2.5's module was built from, with its own
#      `wasix/build-wasix.sh` (OpenSSL, libuv-wasix and Edge.js's C++ for
#      `wasm32-wasix`, then `wasm-opt`), and the toolchain its CI used.
#   3. The published 0.2.5 package with its module swapped for that one, so
#      npm, pnpm, the certificates and the commands are byte for byte what
#      Wasmer published.
#
# Every input is pinned by content hash or commit, and the build is
# reproducible: the same bytes every time, which `environments/build.sh`
# checks against the hash it pins, so a build that comes out different fails
# there rather than shipping. The result goes to dist/package/edgejs/<version>/.
#
#   edgejs/build.sh             build the package
#   EDGEJS_VERIFY=1 ...         build without the patches instead, and check
#                               that the module is the published one, bit
#                               for bit: the proof that the pins below are
#                               what 0.2.5 was built from, and so that the
#                               patches are the only difference
#
# Two things Edge.js's build compiles in are held to what the published
# module has, or neither of those would hold: the source path (`__FILE__`
# in its C++; Edge.js's CI builds in /home/runner/work/edgejs/edgejs, and so
# does this, which is why it needs to be able to create that directory) and
# OpenSSL's build time (SOURCE_DATE_EPOCH).
#
# Drop a patch once the sysroot Edge.js builds on, or Edge.js itself, has
# its fix, and this directory, pinning Wasmer's package again, once a
# `wasmer/edgejs` release has all three.
#
# x86_64 Linux only: the pinned toolchain archives are that platform's. Five
# to ten minutes on four cores, 600 MB of downloads, 4 GB of disk.
# EDGEJS_WORK keeps the downloads and the toolchain somewhere of your
# choosing (default: a scratch directory removed on exit).
#
# Needs: bash, curl, git, make, cmake (3.20+), python3, perl, sha256sum, tar.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Our build of 0.2.5. A changed build is a new number after `iwci.`:
# 1 had the first patch alone, 2 both C library patches, 3 adds the Edge.js
# one.
VERSION="0.2.5-iwci.3"

# Edge.js: the commit 0.2.5's module was built from (the release repackaged
# CI's module for it; the packaging commit after it changes no source). Its
# submodules are pinned by that commit's tree.
EDGEJS_REPO="https://github.com/wasmerio/edgejs.git"
EDGEJS_COMMIT="f3170cc3d2b1bd4497d9057714d7423992044853"
EDGEJS_SUBMODULES=(napi deps/libuv-wasix deps/openssl-wasix)
# Where it is built, and when OpenSSL says it was: the published module's.
EDGEJS_SRC="/home/runner/work/edgejs/edgejs"
EDGEJS_BUILT_ON=1790785857 # Wed Sep 30 16:30:57 2026 UTC
# The published package, for everything in it but the module, and its module.
EDGEJS_WEBC_SHA256="7f956b2311ed904daa2c404b85469aa86cdc4c86e772f57432820ef905ded351"
EDGEJS_MODULE_SHA256="97248a38f8690cb072a26b7bad320cd6230859a0db3340ef466aa6076188626a"

# wasix-libc v2026-07-30.1: the source of the object, and the sysroot built
# from it (the non-PIC exnref exception-handling variant Edge.js links).
WASIX_LIBC_REPO="https://github.com/wasix-org/wasix-libc.git"
WASIX_LIBC_COMMIT="67b2eccf84e5091912ee28f4b6bc0edd1b88e86f"
# patch, the object it changes, and a symbol that object has only when it was
# built from the patched source (`!name`: one it must no longer have).
LIBC_PATCHES=(
  "wasix-libc-145.patch libc-bottom-half/sources/chdir.o !make_absolute_buf"
  "wasix-libc-thread-exit.patch libc-top-half/musl/src/thread/pthread_create.o exit_woken"
)
SYSROOT_URL="https://github.com/wasix-org/wasix-libc/releases/download/v2026-07-30.1/sysroot-exnref-eh.tar.gz"
SYSROOT_SHA256="40c2ebbf3487ab72c0d0359b1643f3e6ae7c51adfe2237ab86492ecb6494a47d"

# The toolchain Edge.js's CI built 0.2.5 with.
WASIXCC_URL="https://github.com/wasix-org/wasixcc/releases/download/v0.4.3/wasixcc-x86_64-unknown-linux-gnu.tar.gz"
WASIXCC_SHA256="3c55abbe0490d0a4736dfe0caaf0763597ae3e50e587c447bf6397b841a0b096"
LLVM_URL="https://github.com/wasix-org/llvm-project/releases/download/21.1.206/LLVM-Linux-x86_64.tar.gz"
LLVM_SHA256="4066b52816c3382d10c5a7d7cfd6252a5f432459f007c143f07e23bf367c43ea"
BINARYEN="version_133"
BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN/binaryen-$BINARYEN-x86_64-linux.tar.gz"
BINARYEN_SHA256="2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489"
# The Wasmer CLI, only to unpack and repack the package.
WASMER_URL="https://github.com/wasmerio/wasmer/releases/download/v7.4.2/wasmer-linux-amd64.tar.gz"
WASMER_SHA256="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"

if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
  echo "error: Edge.js builds on x86_64 Linux only (the pinned toolchain is that platform's)" >&2
  exit 1
fi

work="${EDGEJS_WORK:-$SCRATCH/edgejs}"
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

# checkout <dir> <repo> <commit>: a fresh tree at exactly that commit.
checkout() {
  local dir="$1" repo="$2" commit="$3"
  rm -rf "$dir"
  mkdir -p "$dir"
  git init -q "$dir"
  git -C "$dir" fetch -q --depth 1 "$repo" "$commit"
  git -C "$dir" checkout -q --detach FETCH_HEAD
  if [[ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]]; then
    echo "error: $repo gave $(git -C "$dir" rev-parse HEAD), expected $commit" >&2
    exit 1
  fi
}

# The toolchain, laid out as wasixcc expects and found through its
# environment variables, so nothing is read from or written to ~/.wasixcc.
tc="$work/toolchain"
rm -rf "$tc"
mkdir -p "$tc/wasixcc" "$tc/bin" "$tc/llvm" "$tc/sysroot/sysroot-exnref-eh" "$tc/wasmer"
tar -xzf "$(download "$WASIXCC_URL" "$WASIXCC_SHA256" wasixcc.tar.gz)" -C "$tc/wasixcc"
"$tc/wasixcc/wasixccenv" install-executables "$tc/bin" >/dev/null
tar -xzf "$(download "$LLVM_URL" "$LLVM_SHA256" llvm.tar.gz)" -C "$tc/llvm"
tar -xzf "$(download "$BINARYEN_URL" "$BINARYEN_SHA256" binaryen.tar.gz)" -C "$tc"
tar -xzf "$(download "$SYSROOT_URL" "$SYSROOT_SHA256" sysroot-exnref-eh.tar.gz)" \
  -C "$tc/sysroot/sysroot-exnref-eh" --strip-components=2
tar -xzf "$(download "$WASMER_URL" "$WASMER_SHA256" wasmer.tar.gz)" -C "$tc/wasmer"
export WASIXCC_SYSROOT_PREFIX="$tc/sysroot"
export WASIXCC_LLVM_LOCATION="$tc/llvm"
export WASIXCC_BINARYEN_LOCATION="$tc/binaryen-$BINARYEN"
export PATH="$tc/bin:$tc/binaryen-$BINARYEN/bin:$PATH"

# 1. The C library objects. wasix-libc's Makefile compiles each with the
#    flags the sysroot was built with; the archive keeps every other member.
patch_libc() {
  local libc="$work/wasix-libc" archive="$tc/sysroot/sysroot-exnref-eh/lib/wasm32-wasi/libc.a"
  local entry patch source symbol object member
  checkout "$libc" "$WASIX_LIBC_REPO" "$WASIX_LIBC_COMMIT"
  mkdir -p "$work/check"
  for entry in "${LIBC_PATCHES[@]}"; do
    read -r patch source symbol <<<"$entry"
    object="build/wasm32-wasi/$source"
    member="$(basename "$source")"
    git -C "$libc" apply "$self/$patch"
    TARGET_ARCH=wasm32 TARGET_OS=wasix make -C "$libc" -f Makefile-eh PIC=no EXNREF_EH=yes \
      CC="$tc/llvm/bin/clang" "$object" >"$work/wasix-libc.log" 2>&1 || {
      tail -n 40 "$work/wasix-libc.log" >&2
      exit 1
    }
    if [[ "$("$tc/llvm/bin/llvm-ar" t "$archive" | grep -cxF "$member")" != 1 ]]; then
      echo "error: expected exactly one $member in the sysroot's libc.a" >&2
      exit 1
    fi
    "$tc/llvm/bin/llvm-ar" r "$archive" "$libc/$object"
    # What the module links is the archive, so that is what is checked.
    (cd "$work/check" && rm -f "$member" && "$tc/llvm/bin/llvm-ar" x "$archive" "$member")
    if [[ "$symbol" == !* ]]; then
      if "$tc/llvm/bin/llvm-nm" "$work/check/$member" | grep -qF "${symbol#!}"; then
        echo "error: the sysroot's $member still has ${symbol#!}; $patch was not built in" >&2
        exit 1
      fi
    elif ! "$tc/llvm/bin/llvm-nm" "$work/check/$member" | grep -qF "$symbol"; then
      echo "error: the sysroot's $member has no $symbol; $patch was not built in" >&2
      exit 1
    fi
  done
}
[[ "${EDGEJS_VERIFY:-}" == 1 ]] || patch_libc

# 2. Edge.js's module, with its own build script. The directory is only
#    ever removed when an earlier run of this script made it.
src="$EDGEJS_SRC"
if [[ -e "$src" && ! -f "$src/.git/iwci-build" ]]; then
  echo "error: $src exists and is not this script's; it builds there (see the top of this file)" >&2
  exit 1
fi
if ! mkdir -p "$src" 2>/dev/null; then
  echo "error: cannot create $src; Edge.js has to be built there (see the top of this file)." >&2
  echo "       Try: sudo install -d -o \"\$(id -u)\" $src" >&2
  exit 1
fi
checkout "$src" "$EDGEJS_REPO" "$EDGEJS_COMMIT"
touch "$src/.git/iwci-build"
git -C "$src" -c protocol.version=2 submodule update -q --init --depth 1 "${EDGEJS_SUBMODULES[@]}"
if [[ "${EDGEJS_VERIFY:-}" != 1 ]]; then
  git -C "$src" apply "$self/edgejs-worker-stop.patch"
fi
(cd "$src" && SOURCE_DATE_EPOCH="$EDGEJS_BUILT_ON" ./wasix/build-wasix.sh) >"$work/edgejs.log" 2>&1 || {
  tail -n 60 "$work/edgejs.log" >&2
  exit 1
}
module="$src/build-wasix/edgejs.wasm"
built="$(sha256sum "$module" | cut -d' ' -f1)"
if [[ "${EDGEJS_VERIFY:-}" == 1 ]]; then
  if [[ "$built" != "$EDGEJS_MODULE_SHA256" ]]; then
    echo "error: without the patches the module hashed to $built, not the published $EDGEJS_MODULE_SHA256" >&2
    exit 1
  fi
  echo "verified: without the patches, these inputs build the published module ($built)"
  exit 0
fi
if [[ "$built" == "$EDGEJS_MODULE_SHA256" ]]; then
  echo "error: the built module is the published one; the patched C library was not linked" >&2
  exit 1
fi

# 3. The published package around it.
export WASMER_DIR="$work/wasmer-home"
package="$work/package"
rm -rf "$package"
"$tc/wasmer/bin/wasmer" package unpack --quiet -o "$package" \
  "$(download "https://cdn.wasmer.io/webcimages/$EDGEJS_WEBC_SHA256.webc" "$EDGEJS_WEBC_SHA256" edgejs.webc)"
if [[ "$(sha256sum "$package/modules/edge" | cut -d' ' -f1)" != "$EDGEJS_MODULE_SHA256" ]]; then
  echo "error: the published package's \`edge\` module is not the one expected" >&2
  exit 1
fi
cp "$module" "$package/modules/edge"
# A webc records each file's modification time, which unpacking just set to
# now.
find "$package" -exec touch -h -d "@$EDGEJS_BUILT_ON" {} +
out="$(out_dir package edgejs "$VERSION")"
"$tc/wasmer/bin/wasmer" package build --quiet -o "$out/edgejs.webc" "$package"

echo "built $out/edgejs.webc"
echo "  module  $built"
echo "  package $(sha256sum "$out/edgejs.webc" | cut -d' ' -f1)"
