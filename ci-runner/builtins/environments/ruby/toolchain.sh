# shellcheck shell=bash
# What ruby/build.sh (the interpreter) and ruby/gems/build.sh (gems'
# extensions) share: the Ruby releases, the toolchain that builds for them,
# and the helpers both use. Sourced after builtins/lib.sh; `$(...)` in single quotes
# is make's or rbconfig.rb's, not the shell's.

# minor: Ruby release, the sha256 of its .tar.gz
# (https://cache.ruby-lang.org/pub/ruby/index.txt), our build of it (a
# changed build of the same release is a new number after `iwci.`), and the
# date of its tarball (seconds since 1970), which every file in the package
# is given and OpenSSL calls its build date.
release() {
  case "$1" in
    3.4) echo "3.4.12 5e5d85ad93b0adcccbad47733680f4892bd0078e3342437f7babce01c1872479 4 1792724866" ;;
    4.0) echo "4.0.9 c35350682ff050b79702d57ade4516e7336063f510155d19fb2fb5b3f3909511 4 1792722966" ;;
    *)
      echo "error: no Ruby $1 here; know 3.4 and 4.0" >&2
      exit 2
      ;;
  esac
}

# OpenSSL, which the interpreter's openssl extension links and so do the
# database gems' extensions (gems/build.sh), each its own copy.
# shellcheck disable=SC2034 # build.sh and gems/build.sh read them
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz"
# shellcheck disable=SC2034
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"

# The toolchain and Wasmer CLI Edge.js is built with (edgejs/build.sh): the
# wasix-libc EH+PIC sysroot, wasixcc with wasix-org's LLVM, and Binaryen.
SYSROOT_URL="https://github.com/wasix-org/wasix-libc/releases/download/v2026-07-30.1/sysroot-ehpic.tar.gz"
SYSROOT_SHA256="4795b7112a37215d254a5c67a7c99f9493081c5f78567c15638f9994f217d31d"
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
    echo "error: Ruby builds on x86_64 or aarch64 Linux (the pinned toolchain is those platforms')" >&2
    exit 1
    ;;
esac

# What every module is put through after it is linked (Ruby's POSTLINK, so
# the interpreter, each extension and each encoding): the collector's view
# of locals, then exnref, and the optimisation flattening calls for. Names
# are kept (-g), for stack traces.
# shellcheck disable=SC2034 # build.sh reads it
SPILL_PASSES="--flatten --coalesce-locals --spill-pointers -O2 --emit-exnref -g --strip-dwarf --strip-producers"

if [[ -z "${RUBY_WORK:-}" ]]; then
  work="$SCRATCH/ruby"
else
  work="$RUBY_WORK"
fi
mkdir -p "$work/dl"
jobs="${CARGO_BUILD_JOBS:-$(nproc)}"

# download <url> <sha256> <file>: fetched once, checked every time.
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

# run <log> <command...>: quiet unless it fails, its output in
# $work/<log>.log. The command is often one of these scripts' functions,
# and runs with errexit, so the first step that fails stops it. Not
# `"$@" || ...` or `( ... ) >log || ...`: bash runs whatever is left of
# `||` with errexit off, a subshell that sets it again included, so a
# failed step went unnoticed until a later one failed for want of it.
run() {
  local log="$work/$1.log" status
  shift
  set +e
  (
    set -e
    "$@"
  ) >"$log" 2>&1
  status=$?
  set -e
  if [[ "$status" != 0 ]]; then
    tail -n 60 "$log" >&2
    echo "error: $* failed (log: $log)" >&2
    exit 1
  fi
}

# edit <file> <count> <from> <to>: replace text that must be there exactly
# <count> times.
edit() {
  local file="$1" count="$2" from="$3" to="$4" found
  found="$(FROM="$from" perl -0777 -ne '$n = () = /\Q$ENV{FROM}\E/g; print $n' "$file")"
  if [[ "$found" != "$count" ]]; then
    echo "error: expected $count of \`$from\` in $file, found $found" >&2
    exit 1
  fi
  FROM="$from" TO="$to" perl -0777 -pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$file"
}

# setup_toolchain: the toolchain in $work/toolchain ($tc), laid out as
# wasixcc expects and found through its environment variables, so nothing is
# read from or written to ~/.wasixcc.
setup_toolchain() {
  tc="$work/toolchain"
  # Kept from an earlier run in the same RUBY_WORK when it was unpacked
  # from these very archives.
  local stamp="$WASIXCC_SHA256 $LLVM_SHA256 $BINARYEN_SHA256 $SYSROOT_SHA256 $WASMER_SHA256"
  if [[ "$(cat "$tc/.unpacked" 2>/dev/null)" == "$stamp" ]]; then
    toolchain_env
    return
  fi
  rm -rf "$tc"
  mkdir -p "$tc/wasixcc" "$tc/bin" "$tc/llvm" "$tc/sysroot/sysroot-ehpic" "$tc/wasmer"
  tar -xzf "$(download "$WASIXCC_URL" "$WASIXCC_SHA256" wasixcc.tar.gz)" -C "$tc/wasixcc"
  "$tc/wasixcc/wasixccenv" install-executables "$tc/bin" >/dev/null
  tar -xzf "$(download "$LLVM_URL" "$LLVM_SHA256" llvm.tar.gz)" -C "$tc/llvm"
  tar -xzf "$(download "$BINARYEN_URL" "$BINARYEN_SHA256" binaryen.tar.gz)" -C "$tc"
  tar -xzf "$(download "$SYSROOT_URL" "$SYSROOT_SHA256" sysroot-ehpic.tar.gz)" \
    -C "$tc/sysroot/sysroot-ehpic" --strip-components=2
  tar -xzf "$(download "$WASMER_URL" "$WASMER_SHA256" wasmer.tar.gz)" -C "$tc/wasmer"
  printf '%s' "$stamp" >"$tc/.unpacked"
  toolchain_env
}

# toolchain_env: wasixcc's environment, for the toolchain in $tc.
toolchain_env() {
  export WASIXCC_SYSROOT_PREFIX="$tc/sysroot"
  export WASIXCC_LLVM_LOCATION="$tc/llvm"
  export WASIXCC_BINARYEN_LOCATION="$tc/binaryen-$BINARYEN"
  export WASIXCC_WASM_EXCEPTIONS=legacy
  export WASIXCC_PIC=yes
  # wasm-opt runs once per module, as POSTLINK.
  export WASIXCC_RUN_WASM_OPT=no
  export PATH="$tc/bin:$tc/binaryen-$BINARYEN/bin:$PATH"
}

# host_ruby <source dir>: a native Ruby of the release in $work/host-ruby
# ($host), built from the unpatched source unless it is there already. The
# cross build runs it (BASERUBY), and so does mkmf for a gem's extension.
host_ruby() {
  host="$work/host-ruby"
  if [[ ! -x "$host/bin/ruby" || "$("$host/bin/ruby" -e 'print RUBY_VERSION')" != "$RUBY_VERSION" ]]; then
    rm -rf "$host" "$work/host-build"
    cp -a "$1" "$work/host-build"
    run host-ruby build_host_ruby
  fi
}

build_host_ruby() {
  cd "$work/host-build"
  env -u WASIXCC_SYSROOT_PREFIX -u WASIXCC_LLVM_LOCATION CC=cc ./configure --prefix="$host" \
    --disable-install-doc --without-gmp
  make -j"$jobs"
  make install
}
