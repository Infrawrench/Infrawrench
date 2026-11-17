#!/usr/bin/env bash
# CRuby for `env:ruby`, built from its release tarball for WASIX with
# wasixcc, as Git is (git/build.sh), and loading C extensions with dlopen.
#
#   build.sh <minor>   build the package for that minor (3.4 or 4.0)
#
# The interpreter is a WASIX dynamic main module (`-sMODULE_KIND=dynamic-main`,
# exception handling and position-independent code, wasixcc's "EH+PIC"
# configuration), and every extension, Ruby's own included, is a side module
# it opens with dlopen(). That is how Ruby is built on Linux, so `require`,
# mkmf and RubyGems work as they do there, and a gem's extension built the
# same way (README.md, "Ruby") loads with a plain `require`.
#
# Ruby's own WebAssembly port (ruby.wasm) is not used. It is built for WASI
# preview 1 without threads, processes or sockets, and leans on Binaryen's
# Asyncify for three things: its setjmp/longjmp, its Fibers, and showing the
# garbage collector the values a function holds in WebAssembly locals,
# which live outside linear memory where a conservative collector cannot
# scan them. Here each has another answer:
#
#   - setjmp/longjmp are WebAssembly exceptions, as in Git and Edge.js;
#   - Fibers run on threads of their own (Ruby's `pthread` coroutines);
#   - the collector's view of locals comes from Binaryen's --spill-pointers,
#     run on every module after linking: at each call, every i32 that is
#     still needed afterwards is stored into a slot of its function's stack
#     frame, which the collector scans with the rest of the stack, as it
#     scans spilled registers on a native machine. --flatten first moves
#     every intermediate value into a local, so none is left only on
#     WebAssembly's operand stack. Both passes take the legacy exception
#     instructions only, so everything is compiled with legacy exception
#     handling and the linked module translated to exnref (--emit-exnref)
#     in the same run, which is what wasixcc's own `legacy` mode does. The
#     run is the configure script's POSTLINK, so it applies to the
#     interpreter, the extensions and the encodings alike.
#
# Patches, in this directory:
#
#   ruby-wasix.patch. CRuby has no WASIX platform: on `wasm32-*-wasi*` it
#     builds its Asyncify port. With `__wasix__` defined (wasix-libc's own
#     macro) it builds as a POSIX platform instead, and with no fork() the
#     child processes of `system`, `spawn`, backticks, `IO.popen` and
#     Open3 are started with posix_spawn(), whose file actions do what the
#     forked child would have (redirections, closes, the working directory)
#     and whose environment is the one Ruby built for it. `fork` raises
#     NotImplementedError as on Windows.
#
#   ruby-<minor>.patch. What differs between the releases: turning off
#     ruby.wasm's start-up loop (main.c in 3.4, ruby.h in 4.0), and, in
#     4.0, loading RubyGems at start, which an interpreter built without
#     a builtin binary (as every cross build is) skipped.
#
#   The configure script is edited rather than patched, and every edit is
#   checked to change exactly what it expects (edit_configure, below): its
#   `wasi*` cases select the Asyncify port and would match `wasix` too, so
#   they match `wasi` alone; and POSIX's POSTLINK takes the value given.
#
#   wasix-libc-thread-start.patch. A new thread's stack pointer is set in
#   wasi_thread_start, which then held its arguments across a call, so
#   --spill-pointers gave it a stack frame below a stack pointer of 0. The
#   patch has C initialise the thread's TLS instead.
#
# The C library is Edge.js's (edgejs/build.sh): wasix-libc v2026-07-30.1,
# here its EH+PIC sysroot with legacy exception handling, with the objects
# edgejs/'s patches change rebuilt from that tag's source, and this
# directory's thread-start patch.
#
# Built into the interpreter, from source: zlib, OpenSSL 3.5.9 and libyaml,
# for zlib, openssl and psych. Not built: fiddle (no libffi), pty (no
# pseudo-terminals in WASIX), win32ole, readline-ext, and documentation.
#
# Every input is pinned by content hash, and the build is reproducible: the
# same bytes every time, which `environments/build.sh` checks against the
# hash it pins. Source paths are mapped away (`-ffile-prefix-map`), OpenSSL's
# build date is the tarball's, and the package's files all carry that date.
# The result goes to dist/package/ruby/<version>/ruby.webc.
#
# Linux, x86_64 or aarch64 (the toolchain archives are pinned for both). It
# builds a native Ruby of the same release first, which the cross build
# runs (BASERUBY). About ten minutes on eight cores and 3 GB of disk per
# minor. RUBY_WORK keeps the downloads and the toolchain somewhere of your
# choosing (default: a scratch directory removed on exit).
#
# Needs: bash, curl, git, make, perl, sha256sum, tar, xz, a C compiler and
# what a native Ruby needs to build (bison is not: the tarball has parse.c).
# `$(...)` in single quotes below is make's (LDSHARED, LIBRUBYARG) or
# rbconfig.rb's, not the shell's.
# shellcheck disable=SC2016
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The release pins, the toolchain and the helpers below (download, run,
# edit), which gems/build.sh shares.
# shellcheck source=builtins/environments/ruby/toolchain.sh
source "$self/toolchain.sh"

if [[ $# -ne 1 ]]; then
  echo "usage: build.sh <minor>   (3.4 or 4.0)" >&2
  exit 2
fi
minor="$1"
read -r RUBY_VERSION RUBY_SHA256 BUILD BUILT_ON <<<"$(release "$minor")"
VERSION="$RUBY_VERSION-iwci.$BUILD"
RUBY_URL="https://cache.ruby-lang.org/pub/ruby/$minor/ruby-$RUBY_VERSION.tar.gz"

ZLIB_URL="https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz"
ZLIB_SHA256="bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
LIBYAML_URL="https://github.com/yaml/libyaml/releases/download/0.2.5/yaml-0.2.5.tar.gz"
LIBYAML_SHA256="c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4"
# Mozilla's CA certificates as curl.se extracted them (git/build.sh pins the
# same one), OpenSSL's default file: /opt/ruby/ssl/cert.pem.
CACERT_URL="https://curl.se/ca/cacert-2026-11-05.pem"
CACERT_SHA256="427c064216761a1e72a8b30f0d954d08cb6e4435a82091fb865afd20c8497285"

# Where Ruby lives in a job: the interpreter is the package command `ruby`
# (/usr/bin/ruby, which is also what RbConfig.ruby and every script's `#!`
# name), and everything else is the package's files under /opt/ruby, with
# its commands (gem, bundle, rake, irb, ...) in /opt/ruby/bin.
PREFIX="/opt/ruby"

# The C library, toolchain and Wasmer CLI Edge.js is built with
# (edgejs/build.sh), and its patches to the C library, here applied to the
# EH+PIC sysroot: each entry is a patch, then the objects it changes, each
# with a symbol that shows it was rebuilt (`!` for one that must be gone).
WASIX_LIBC_REPO="https://github.com/wasix-org/wasix-libc.git"
WASIX_LIBC_COMMIT="67b2eccf84e5091912ee28f4b6bc0edd1b88e86f"
LIBC_PATCHES=(
  "edgejs/wasix-libc-145.patch libc-bottom-half/sources/chdir.o !make_absolute_buf"
  "edgejs/wasix-libc-thread-exit.patch libc-top-half/musl/src/thread/pthread_create.o exit_woken"
  "edgejs/wasix-libc-modes.patch libc-bottom-half/sources/posix.o __wasilibc_iwci_fill_fd_mode libc-bottom-half/cloudlibc/src/libc/sys/stat/fstat.o __wasilibc_iwci_fill_fd_mode"
  "edgejs/wasix-libc-getrusage.patch libc-top-half/musl/src/misc/getrusage.o __wasilibc_iwci_rusage"
  "ruby/wasix-libc-thread-start.patch libc-top-half/musl/src/thread/wasm32/wasi_thread_start.o !__wasm_init_tls libc-top-half/musl/src/thread/pthread_create.o __wasm_init_tls"
)

# 1. The toolchain (toolchain.sh).
setup_toolchain

# 2. The C library objects, as edgejs/build.sh rebuilds them, for the PIC
#    sysroot with legacy exception handling.
libc="$work/wasix-libc"
archive="$tc/sysroot/sysroot-ehpic/lib/wasm32-wasi/libc.a"
rm -rf "$libc" "$work/check"
mkdir -p "$libc" "$work/check"
git init -q "$libc"
git -C "$libc" fetch -q --depth 1 "$WASIX_LIBC_REPO" "$WASIX_LIBC_COMMIT"
git -C "$libc" checkout -q --detach FETCH_HEAD
for entry in "${LIBC_PATCHES[@]}"; do
  patch="${entry%% *}"
  read -ra pairs <<<"${entry#* }"
  git -C "$libc" apply "$self/../$patch"
  for ((i = 0; i < ${#pairs[@]}; i += 2)); do
    source="${pairs[i]}"
    symbol="${pairs[i + 1]}"
    object="build/wasm32-wasi/$source"
    member="$(basename "$source")"
    rm -f "$libc/$object"
    run wasix-libc env TARGET_ARCH=wasm32 TARGET_OS=wasix make -C "$libc" -f Makefile-eh PIC=yes \
      EXNREF_EH=no CC="$tc/llvm/bin/clang" "$object"
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

# 3. The libraries, installed under $deps as if in /usr, as git/build.sh
#    builds zlib and OpenSSL (here position-independent, as everything in a
#    dynamic main module is).
deps="$work/deps"
src="$work/src"
rm -rf "$deps" "$src"
mkdir -p "$deps/usr/lib" "$deps/usr/include" "$src/zlib" "$src/openssl" "$src/libyaml" "$src/ruby"
map="-ffile-prefix-map=$src/= -ffile-prefix-map=$deps/= -ffile-prefix-map=$work/="
tar -xzf "$(download "$ZLIB_URL" "$ZLIB_SHA256" zlib.tar.gz)" -C "$src/zlib" --strip-components=1
objects=()
for name in adler32 crc32 deflate infback inffast inflate inftrees trees zutil compress uncompr \
  gzclose gzlib gzread gzwrite; do
  # shellcheck disable=SC2086 # $map is several flags
  wasixcc -O2 $map -D_LARGEFILE64_SOURCE=1 -DHAVE_HIDDEN -c "$src/zlib/$name.c" -o "$src/zlib/$name.o"
  objects+=("$src/zlib/$name.o")
done
wasixar rcsD "$deps/usr/lib/libz.a" "${objects[@]}"
cp "$src/zlib/zlib.h" "$src/zlib/zconf.h" "$deps/usr/include/"

# OpenSSL, the libraries alone, without what WASIX lacks (assembly, loadable
# modules and engines, secure memory, datagrams, AF_ALG). Its default
# certificate file is $PREFIX/ssl/cert.pem, which the package carries.
tar -xzf "$(download "$OPENSSL_URL" "$OPENSSL_SHA256" openssl.tar.gz)" -C "$src/openssl" --strip-components=1
(
  cd "$src/openssl"
  CC=wasixcc AR=wasixar RANLIB=wasixranlib SOURCE_DATE_EPOCH="$BUILT_ON" ./Configure linux-generic32 \
    no-asm no-shared no-dso no-module no-engine no-tests no-apps no-docs no-afalgeng no-dgram \
    no-secure-memory no-ui-console --prefix=/usr --openssldir="$PREFIX/ssl" --libdir=lib
  SOURCE_DATE_EPOCH="$BUILT_ON" make -j"$jobs" build_libs
  make install_dev DESTDIR="$deps"
) >"$work/openssl.log" 2>&1 || {
  tail -n 40 "$work/openssl.log" >&2
  exit 1
}

# libyaml, for psych, compiled as its Makefile would (its configure
# script predates WASI and does not know the host).
tar -xzf "$(download "$LIBYAML_URL" "$LIBYAML_SHA256" libyaml.tar.gz)" -C "$src/libyaml" --strip-components=1
objects=()
for name in api dumper emitter loader parser reader scanner writer; do
  # shellcheck disable=SC2086 # $map is several flags
  wasixcc -O2 $map -I"$src/libyaml/include" -DYAML_VERSION_MAJOR=0 -DYAML_VERSION_MINOR=2 \
    -DYAML_VERSION_PATCH=5 '-DYAML_VERSION_STRING="0.2.5"' \
    -c "$src/libyaml/src/$name.c" -o "$src/libyaml/$name.o"
  objects+=("$src/libyaml/$name.o")
done
wasixar rcsD "$deps/usr/lib/libyaml.a" "${objects[@]}"
cp "$src/libyaml/include/yaml.h" "$deps/usr/include/"

# What every extension links (configure's DLDFLAGS): a constructor that
# touches the stack, so the module imports __stack_pointer, which
# --spill-pointers needs for the frames it adds. A side module whose own
# functions never use the stack would not import it (README.md, "Ruby").
mkdir -p "$deps/usr/lib/ruby-wasix"
cp "$self/stack-anchor.c" "$src/stack-anchor.c"
# shellcheck disable=SC2086 # $map is several flags
wasixcc -O2 $map -c "$src/stack-anchor.c" -o "$deps/usr/lib/ruby-wasix/stack-anchor.o"

# 4. A native Ruby of the same release, which the cross build runs.
tar -xzf "$(download "$RUBY_URL" "$RUBY_SHA256" "ruby-$RUBY_VERSION.tar.gz")" -C "$src/ruby" --strip-components=1
host_ruby "$src/ruby"

# 5. Ruby for WASIX, installed into a staging directory.
ruby_src="$src/ruby"
patch -s -d "$ruby_src" -p1 <"$self/ruby-wasix.patch"
patch -s -d "$ruby_src" -p1 <"$self/ruby-$minor.patch"
# The Asyncify port's cases: `wasi*` would match `wasix`.
edit "$ruby_src/configure" "$(grep -c '^  wasi\*) :$' "$ruby_src/configure")" $'\n  wasi*) :' $'\n  wasi) :'
edit "$ruby_src/configure" 1 $'\n  emscripten*|wasi*) :' $'\n  emscripten*|wasi) :'
edit "$ruby_src/configure" 1 $'\n  *-wasi*) :' $'\n  *-wasi) :'
if grep -q 'wasi\*' "$ruby_src/configure"; then
  echo "error: configure still has a \`wasi*\` case" >&2
  exit 1
fi
# A dynamic linker, as on Linux: extensions are shared objects.
edit "$ruby_src/configure" 1 $'\n  linux* | gnu* | k*bsd*-gnu | netbsd* | bsdi* | kopensolaris*-gnu | haiku*) :' \
  $'\n  linux* | gnu* | k*bsd*-gnu | netbsd* | bsdi* | kopensolaris*-gnu | haiku* | wasix*) :'
# POSTLINK as given.
edit "$ruby_src/configure" 1 $'\nPOSTLINK=:\n' $'\nPOSTLINK=${POSTLINK-:}\n'
# Extensions link no C library: the interpreter has all of it, for them too.
edit "$ruby_src/configure" 1 $'\n  cygwin*|msys*|mingw*|haiku*|darwin*) :\n\n    : ${DLDLIBS=""}' \
  $'\n  cygwin*|msys*|mingw*|haiku*|darwin*|wasix*) :\n\n    : ${DLDLIBS=""}'

build="$work/build"
stage="$work/stage"
rm -rf "$build" "$stage"
mkdir -p "$build"
(
  cd "$build"
  # The answers configure cannot find by running a program: the stack grows
  # down, and there is no fork() (wasix-libc's vfork() shares the parent's
  # memory, which Ruby's child code would overwrite). setgroups() is there
  # without getgroups(), which Process.groups= needs as well, and there is
  # no stack protector (nothing traps on its canary). memcmp works (its
  # check runs a program, and Ruby would link its own beside the C
  # library's). Nothing is taken from what this machine has installed,
  # which rbconfig.rb would otherwise record: no pkg-config (`false` does
  # not answer --version, so configure leaves PKG_CONFIG empty), no rustc,
  # man pages in man format whether or not groff is here, and grep and
  # mkdir by name rather than by where they are on this PATH.
  CC=wasixcc CXX=wasix++ AR=wasixar RANLIB=wasixranlib NM=wasixnm LD=wasixcc \
    CPPFLAGS="-D__wasix__=1 -I$deps/usr/include" \
    LDFLAGS="-L$deps/usr/lib" \
    LDSHARED='$(CC) -shared' \
    DLDFLAGS="$deps/usr/lib/ruby-wasix/stack-anchor.o" \
    POSTLINK="wasm-opt $SPILL_PASSES -o \$@ \$@" \
    optflags="-O2" debugflags="$map" \
    rb_cv_stack_grow_dir_wasm32=-1 ac_cv_func_fork=no ac_cv_func_fork_works=no \
    ac_cv_func_vfork=no ac_cv_func_vfork_works=no ac_cv_func_setgroups=no ac_cv_func_initgroups=no \
    ac_cv_func_memcmp_working=yes stack_protector=no \
    PKG_CONFIG=false RUSTC=no GREP=grep EGREP="grep -E" MKDIR_P="mkdir -p" \
    "$ruby_src/configure" --host=wasm32-unknown-wasix --build="$(uname -m)-linux-gnu" \
    --prefix="$PREFIX" --bindir=/usr/bin --with-baseruby="$host/bin/ruby" \
    --with-coroutine=pthread --disable-install-doc --disable-jit-support --disable-yjit \
    --disable-dtrace --without-gmp --without-valgrind --with-mantype=man \
    --with-out-ext=pty,fiddle,win32,win32ole,readline \
    --with-openssl-dir="$deps/usr" --with-libyaml-dir="$deps/usr" --with-zlib-dir="$deps/usr"
) >"$work/configure.log" 2>&1 || {
  tail -n 60 "$work/configure.log" >&2
  exit 1
}
# The interpreter links libruby-static.a by its path: wasixcc puts `-l`
# libraries ahead of the objects, and the archive's own dmyext.o then came
# in beside the one the link names.
run make make -C "$build" -j"$jobs" LIBRUBYARG='$(LIBRUBY_A)'
run install make -C "$build" install DESTDIR="$stage" LIBRUBYARG='$(LIBRUBY_A)'

api="$("$host/bin/ruby" -e 'print RbConfig::CONFIG["ruby_version"]')"
archdir="$stage$PREFIX/lib/ruby/$api/wasm32-wasix"

# 6. A gem's extension, built against what was just installed the way
#    README.md ("Ruby") says to build one, which checks the recipe;
#    builtins/test.sh loads it in a job. The native Ruby runs mkmf with the
#    installed rbconfig.rb, which finds the headers beside it.
check="$work/check-ext"
rm -rf "$check"
cp -R "$self/check-ext" "$check"
run check-ext env -C "$check" sh -c '"$1" --disable-gems -I "$2" -r rbconfig extconf.rb && make V=1' \
  - "$host/bin/ruby" "$archdir"
mkdir -p "$dist/test/ruby/$minor"
cp "$check/wasix_check.so" "$dist/test/ruby/$minor/"

# 7. The package: the interpreter as its command, and everything else under
#    /opt/ruby. rbconfig.rb keeps what a gem's extension is built with, less
#    this machine: paths under the work directory and the build triple,
#    which would make x86_64 and ARM64 builds differ (`build_vendor` is `pc`
#    on one and `unknown` on the other).
package="$work/package"
rm -rf "$package"
mkdir -p "$package/modules" "$package/ruby/bin" "$package/ruby/lib" "$package/ruby/ssl"
cp "$stage/usr/bin/ruby" "$package/modules/ruby"
for file in "$stage/usr/bin/"*; do
  [[ "$(basename "$file")" == ruby ]] || cp "$file" "$package/ruby/bin/"
done
cp -R "$stage$PREFIX/lib/ruby" "$package/ruby/lib/"
# The interpreter as an archive, which mkmf links its checks against
# (have_func, have_library) when a gem's extension is built (README.md).
cp "$stage$PREFIX/lib/libruby-static.a" "$package/ruby/lib/"
cp -R "$stage$PREFIX/include" "$package/ruby/"
cp "$ruby_src/COPYING" "$ruby_src/BSDL" "$package/ruby/"
cp "$deps/usr/lib/ruby-wasix/stack-anchor.o" "$package/ruby/lib/ruby/$api/wasm32-wasix/ruby-wasix-stack-anchor.o"
cp "$(download "$CACERT_URL" "$CACERT_SHA256" cacert.pem)" "$package/ruby/ssl/cert.pem"
rbconfig="$package/ruby/lib/ruby/$api/wasm32-wasix/rbconfig.rb"
edit "$rbconfig" 1 "CONFIG[\"DLDFLAGS\"] = \"$deps/usr/lib/ruby-wasix/stack-anchor.o\"" \
  'CONFIG["DLDFLAGS"] = "$(rubyarchdir)/ruby-wasix-stack-anchor.o"'
edit "$rbconfig" 1 "CONFIG[\"CPPFLAGS\"] = \"-D__wasix__=1 -I$deps/usr/include " 'CONFIG["CPPFLAGS"] = "-D__wasix__=1 '
edit "$rbconfig" 1 "CONFIG[\"LDFLAGS\"] = \"-L. -L$deps/usr/lib\"" 'CONFIG["LDFLAGS"] = "-L."'
edit "$rbconfig" 1 "CONFIG[\"debugflags\"] = \"$map\"" 'CONFIG["debugflags"] = ""'
edit "$rbconfig" 1 " '--build=$(uname -m)-linux-gnu'" ""
edit "$rbconfig" 1 " 'build_alias=$(uname -m)-linux-gnu'" ""
# CFLAGS is `$(cflags)` as configure means it to be, which it writes out
# expanded instead when the work directory's path has a `.` in it (as
# lib.sh's scratch directory does): configure escapes the pattern it
# recognises its own flags by, and its escaping turns each `.` into a
# literal `&`, so nothing matches. The expansion is that of the moment
# (no warning flags yet), and names the work directory.
if ! grep -qxF '  CONFIG["CFLAGS"] = "$(cflags)"' "$rbconfig"; then
  edit "$rbconfig" 1 "  CONFIG[\"CFLAGS\"] = \"-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=2  -O2 -fno-fast-math $map  -fdeclspec\"" \
    '  CONFIG["CFLAGS"] = "$(cflags)"'
fi
if [[ "$(grep -cxF '  CONFIG["CFLAGS"] = "$(cflags)"' "$rbconfig")" != 1 ]]; then
  echo "error: rbconfig.rb's CFLAGS is not \$(cflags)" >&2
  exit 1
fi
for key in build build_alias build_cpu build_vendor build_os; do
  perl -pi -e "s/^  CONFIG\\[\"$key\"\\] = \".*\"\$/  CONFIG[\"$key\"] = \"unknown\"/" "$rbconfig"
done
perl -pi -e "s|\\Q$work\\E|/build|g" "$rbconfig"
if grep -q "$(uname -m)" "$rbconfig"; then
  echo "error: rbconfig.rb still names this machine ($(uname -m))" >&2
  exit 1
fi
cat >"$package/wasmer.toml" <<TOML
[package]
name = "iwci/ruby"
version = "$VERSION"
description = "CRuby $RUBY_VERSION for WASIX, built by builtins/environments/ruby/build.sh"
license = "Ruby OR BSD-2-Clause"

[fs]
"$PREFIX" = "ruby"

[[module]]
name = "ruby"
source = "modules/ruby"
abi = "wasi"

[[command]]
name = "ruby"
module = "ruby"
runner = "wasi"
TOML
if grep -rlF "$work" "$package"; then
  echo "error: the files above name the work directory" >&2
  exit 1
fi
find "$package" -exec touch -h -d "@$BUILT_ON" {} +
out="$(out_dir package ruby "$VERSION")"
export WASMER_DIR="$work/wasmer-home"
"$tc/wasmer/bin/wasmer" package build --quiet -o "$out/ruby.webc" "$package"

size="$(stat -c %s "$out/ruby.webc")"
echo "built $out/ruby.webc"
echo "  module $(sha256sum "$package/modules/ruby" | cut -d' ' -f1) ($(wc -c <"$package/modules/ruby") bytes)"
echo "  package $(sha256sum "$out/ruby.webc" | cut -d' ' -f1) ($((size >> 20)) MiB)"
echo "  check extension $dist/test/ruby/$minor/wasix_check.so"
# The store's limit for one file, which a publish would hit later.
if ((size > 256 << 20)); then
  echo "error: ruby.webc is over the store's 256 MiB limit for one file" >&2
  exit 1
fi
