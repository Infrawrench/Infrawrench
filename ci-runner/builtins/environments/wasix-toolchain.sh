# shellcheck shell=bash
# The C toolchain tar/build.sh and openssl/build.sh build with: the one
# git/build.sh pins (wasixcc, wasix-org's LLVM, Binaryen, the wasix-libc
# sysroot Edge.js links and the Wasmer CLI that packages the result), with
# the same three objects of the C library rebuilt from edgejs/'s patches, so
# relative paths cannot trade between threads (#937), a thread's exit
# writes nothing into a joined stack (#967) and file modes are the runner's
# (#959). git/build.sh keeps its own copy of these steps, so that Git's
# pinned build is untouched by a change here.
#
# Sourced with $work (downloads and the toolchain go under it) and $self
# (the sourcing script's directory) set. Defines download() and exports
# what wasixcc reads; leaves $tc set to the toolchain.
#
# Linux, x86_64 or aarch64 (the toolchain archives are pinned for both).

: "${work:?wasix-toolchain.sh needs \$work}" "${self:?wasix-toolchain.sh needs \$self}"

WASIX_LIBC_REPO="https://github.com/wasix-org/wasix-libc.git"
WASIX_LIBC_COMMIT="67b2eccf84e5091912ee28f4b6bc0edd1b88e86f"
LIBC_PATCHES=(
  "wasix-libc-145.patch libc-bottom-half/sources/chdir.o !make_absolute_buf"
  "wasix-libc-thread-exit.patch libc-top-half/musl/src/thread/pthread_create.o exit_woken"
  "wasix-libc-modes.patch libc-bottom-half/sources/posix.o __wasilibc_iwci_fill_fd_mode libc-bottom-half/cloudlibc/src/libc/sys/stat/fstat.o __wasilibc_iwci_fill_fd_mode"
)
SYSROOT_URL="https://github.com/wasix-org/wasix-libc/releases/download/v2026-07-30.1/sysroot-exnref-eh.tar.gz"
SYSROOT_SHA256="40c2ebbf3487ab72c0d0359b1643f3e6ae7c51adfe2237ab86492ecb6494a47d"
BINARYEN="version_133"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    WASIXCC_URL="https://github.com/wasix-org/wasixcc/releases/download/v0.4.3/wasixcc-x86_64-unknown-linux-gnu.tar.gz"
    WASIXCC_SHA256="3c55abbe0490d0a4736dfe0caaf0763597ae3e50e587c447bf6397b841a0b096"
    LLVM_URL="https://github.com/wasix-org/llvm-project/releases/download/21.1.206/LLVM-Linux-x86_64.tar.gz"
    LLVM_SHA256="4066b52816c3382d10c5a7d7cfd6252a5f432459f007c143f07e23bf367c43ea"
    BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN/binaryen-$BINARYEN-x86_64-linux.tar.gz"
    BINARYEN_SHA256="2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489"
    WASMER_URL="https://github.com/wasmerio/wasmer/releases/download/v7.4.2/wasmer-linux-amd64.tar.gz"
    WASMER_SHA256="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
    ;;
  Linux-aarch64)
    WASIXCC_URL="https://github.com/wasix-org/wasixcc/releases/download/v0.4.3/wasixcc-aarch64-unknown-linux-gnu.tar.gz"
    WASIXCC_SHA256="7285c0afa07fdcec80956aef27149989365a477a6e31e22c02503ba193f8c123"
    LLVM_URL="https://github.com/wasix-org/llvm-project/releases/download/21.1.206/LLVM-Linux-aarch64.tar.gz"
    LLVM_SHA256="470a2eb2ad54b3a2f3d9904aeb5f4fa4f4dc96ab9f8a6e903663f63fdb5bbfc3"
    BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN/binaryen-$BINARYEN-aarch64-linux.tar.gz"
    BINARYEN_SHA256="89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8"
    WASMER_URL="https://github.com/wasmerio/wasmer/releases/download/v7.4.2/wasmer-linux-aarch64.tar.gz"
    WASMER_SHA256="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"
    ;;
  *)
    echo "error: this builds on x86_64 or aarch64 Linux (the pinned toolchain is those platforms')" >&2
    exit 1
    ;;
esac

mkdir -p "$work/dl"

# download <url> <sha256> <file>: fetched once, checked every time. Every
# failure is retried: a mirror can cut a transfer short with an HTTP/2
# PROTOCOL_ERROR, which curl does not count as transient.
download() {
  local url="$1" sha="$2" file="$work/dl/$3"
  [[ -f "$file" ]] || curl -fsSL --retry 5 --retry-all-errors -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    rm -f "$file"
    exit 1
  fi
  printf '%s\n' "$file"
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
export WASIXCC_WASM_EXCEPTIONS=exnref
# wasm-opt runs once, on each linked module.
export WASIXCC_RUN_WASM_OPT=no
export PATH="$tc/bin:$tc/binaryen-$BINARYEN/bin:$PATH"

# The C library objects, as edgejs/build.sh rebuilds them: wasix-libc's
# Makefile compiles each with the flags the sysroot was built with, and the
# archive keeps every other member.
libc="$work/wasix-libc"
archive="$tc/sysroot/sysroot-exnref-eh/lib/wasm32-wasi/libc.a"
rm -rf "$libc"
mkdir -p "$libc" "$work/check"
git init -q "$libc"
git -C "$libc" fetch -q --depth 1 "$WASIX_LIBC_REPO" "$WASIX_LIBC_COMMIT"
git -C "$libc" checkout -q --detach FETCH_HEAD
for entry in "${LIBC_PATCHES[@]}"; do
  patch="${entry%% *}"
  read -ra pairs <<<"${entry#* }"
  git -C "$libc" apply "$self/../edgejs/$patch"
  for ((i = 0; i < ${#pairs[@]}; i += 2)); do
    source="${pairs[i]}"
    symbol="${pairs[i + 1]}"
    object="build/wasm32-wasi/$source"
    member="$(basename "$source")"
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
done
