#!/usr/bin/env bash
# Git for the `env:` environments: Git itself, built from its release
# tarball for WASIX with wasixcc, as one package every environment carries
# (`git` on PATH).
#
# Git is one program (`git`) whose subcommands are built in, plus
# `git-remote-https` (HTTP and HTTPS remotes, on libcurl and OpenSSL), shell
# scripts for the few subcommands that are not built in (`git submodule`,
# `git merge -s octopus`, `git mergetool`, ...) and the templates `git init`
# copies. Three patches to Git's source, each used through a define of its
# own so the rest of Git builds as it would anywhere:
#
#   git-spawn.patch (SPAWN_WITHOUT_FORK). Git starts other programs (its own
#     subcommands, hooks, the other end of a `file://` remote, an editor)
#     through `start_command`, which forks and execs. The C library Edge.js
#     is built on, with exception handling, has no `fork()` (only a
#     `vfork()` built on setjmp), so `start_command` starts them with
#     `posix_spawn()`: the same descriptors, working directory and messages
#     as the forked child, in the same order.
#
#   git-exec-bit.patch (EXEC_BIT_UNRELIABLE). Git looks for a program on
#     PATH and in its exec path by the executable bit. A package's own files
#     (the scripts in /usr/libexec/git-core) have no mode the runner knows,
#     so they read as 0644, and `git submodule` was "not a git command". A
#     file without the bit counts when it starts with `#!` or is WebAssembly,
#     as Git's Windows port peeks for `#!`.
#
#   git-no-hard-links.patch (NO_HARD_LINKS). The job's file system cannot
#     give a file a second name: link() appeared to work, and the next
#     process found neither name (#1052; it now fails with EPERM). Here
#     link() fails without trying, so Git renames object files into place
#     (OBJECT_CREATION_USES_RENAMES) and a clone from a path copies. Drop it
#     once the job's file system has hard links.
#
# Everything is linked with the C library Edge.js links (the same sysroot,
# with the same three objects rebuilt from edgejs/'s patches): relative
# paths that threads cannot trade (#937), a thread exit that writes nothing
# into a joined stack (#967), and the runner's file modes (#959), so Git
# checks an executable out as 0755, `git init` sets `core.filemode` true
# (its probe chmods .git/config, which it renamed into place, and reads the
# mode back, #1054), and an executable is recorded as `100755`.
# edgejs/build.sh says what each patch is.
#
# Not built: Perl and Python commands (`send-email`, `svn`, `p4`, ...),
# `git daemon`, `git http-backend`, `git imap-send`, `git shell`,
# `git http-fetch` (the dumb HTTP protocol), gettext (messages are English)
# and `scalar`. README.md, "Git", says what a job can rely on.
#
# Every input is pinned by content hash, and the build is reproducible: the
# same bytes every time, which `environments/build.sh` checks against the
# hash it pins. Source paths are mapped away (`-ffile-prefix-map`),
# OpenSSL's build date is the tarball's, and the package's files all carry
# that date. The result goes to dist/package/git/<version>/.
#
# Linux, x86_64 or aarch64 (the toolchain archives are pinned for both).
# About three minutes on four cores, 500 MB of downloads, 2 GB of disk.
# GIT_WORK keeps the downloads and the toolchain somewhere of your choosing
# (default: a scratch directory removed on exit).
#
# Needs: bash, curl, git, make, perl, sha256sum, tar, xz.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Our build of Git 2.56.1. A changed build is a new number after `iwci.`.
VERSION="2.56.1-iwci.1"
# Applied to Git's source in this order (see the top of this file).
GIT_PATCHES=(git-spawn.patch git-exec-bit.patch git-no-hard-links.patch)
GIT_URL="https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.56.1.tar.xz"
GIT_SHA256="f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f"
# The tarball's own date, which every file in the package is given.
BUILT_ON="202611101749.00" # touch -t, in UTC
# SOURCE_DATE_EPOCH, for OpenSSL's "built on": the same date.
BUILT_ON_EPOCH=1794332940
ZLIB_URL="https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz"
ZLIB_SHA256="bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
CURL_URL="https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz"
CURL_SHA256="8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5"
# Mozilla's CA certificates as curl.se extracted them, the bundle libcurl
# reads (go/build.sh pins the same one). GIT_SSL_CAINFO or http.sslCAInfo
# names another.
CACERT_URL="https://curl.se/ca/cacert-2026-11-05.pem"
CACERT_SHA256="427c064216761a1e72a8b30f0d954d08cb6e4435a82091fb865afd20c8497285"
CA_BUNDLE="/usr/share/git-core/ca-certificates.crt"

# The C library, toolchain and Wasmer CLI Edge.js is built with
# (edgejs/build.sh), and its patches to the C library.
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
    echo "error: Git builds on x86_64 or aarch64 Linux (the pinned toolchain is those platforms')" >&2
    exit 1
    ;;
esac

# What Git is built with, besides the platform's defaults: no Perl, Python,
# Tcl/Tk, gettext or expat (`http-push`), OpenSSL for TLS only (SHA-1 is
# Git's own collision-detecting one, SHA-256 its own block), no fork
# (`daemonize` fails as on Windows; `start_command` spawns), no Unix
# sockets (`credential-cache`), files read rather than mapped, and the C
# library's regex lacks REG_STARTEND, so Git's own. `uname_*` keep
# config.mak.uname from applying the build host's settings, and
# CURL_CONFIG=false the build host's curl-config.
MAKE_ARGS=(
  uname_S=WASIX uname_M=wasm32 uname_O=WASIX uname_R=1 uname_P=wasm32 uname_V=1
  CC=wasixcc AR=wasixar
  prefix=/usr
  NO_PERL=YesPlease NO_PYTHON=YesPlease NO_TCLTK=YesPlease NO_GETTEXT=YesPlease
  NO_EXPAT=YesPlease NO_OPENSSL=YesPlease NO_RUST=YesPlease CURL_CONFIG=false
  NO_POSIX_GOODIES=UnfortunatelyYes NO_UNIX_SOCKETS=YesPlease NO_MMAP=YesPlease
  NO_REGEX=NeedsStartEnd OBJECT_CREATION_USES_RENAMES=UnfortunatelyNeedsTo
  HAVE_CLOCK_GETTIME=YesPlease HAVE_CLOCK_MONOTONIC=YesPlease HAVE_GETDELIM=YesPlease
  HAVE_ALLOCA_H=YesPlease HAVE_PATHS_H=YesPlease
  NO_INSTALL_HARDLINKS=YesPlease SKIP_DASHED_BUILT_INS=YesPlease
  INSTALL_SYMLINKS=
)
# The commands the package gives each module: `git`, and the names the
# other end of a `file://` or local remote is started by (through `sh -c`,
# so they have to be found on PATH; Git runs a built-in by the name it was
# started as); and the remote helper, by each scheme it serves.
COMMANDS=(git git-upload-pack git-receive-pack git-upload-archive)
REMOTE_COMMANDS=(git-remote-http git-remote-https git-remote-ftp git-remote-ftps)
# What goes in /usr/libexec/git-core beside them: the subcommands that are
# shell scripts, and the one small program they use.
LIBEXEC_PROGRAMS=(git-sh-i18n--envsubst)

if [[ -z "${GIT_WORK:-}" ]]; then
  work="$SCRATCH/git"
else
  work="$GIT_WORK"
fi
mkdir -p "$work/dl"

# download <url> <sha256> <file>: fetched once, checked every time. Every
# failure is retried: kernel.org's mirror has cut a transfer short with an
# HTTP/2 PROTOCOL_ERROR, which curl does not count as transient.
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
# wasm-opt runs once, below, on the linked module.
export WASIXCC_RUN_WASM_OPT=no
export PATH="$tc/bin:$tc/binaryen-$BINARYEN/bin:$PATH"

# 1. The C library objects, as edgejs/build.sh rebuilds them: wasix-libc's
#    Makefile compiles each with the flags the sysroot was built with, and
#    the archive keeps every other member.
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

# 2. The libraries, installed under $deps as if in /usr (OpenSSL compiles
#    its directories in). zlib is compiled as its Makefile would (its
#    configure cannot drive wasixcc: it adds -fPIC).
deps="$work/deps"
src="$work/src"
rm -rf "$deps" "$src"
mkdir -p "$deps/usr/lib" "$deps/usr/include" "$src/zlib" "$src/openssl" "$src/curl" "$src/git"
map="-ffile-prefix-map=$src/= -ffile-prefix-map=$deps/="
tar -xzf "$(download "$ZLIB_URL" "$ZLIB_SHA256" zlib.tar.gz)" -C "$src/zlib" --strip-components=1
objects=()
for name in adler32 crc32 deflate infback inffast inflate inftrees trees zutil compress uncompr \
  gzclose gzlib gzread gzwrite; do
  # shellcheck disable=SC2086 # $map is two flags
  wasixcc -O2 $map -D_LARGEFILE64_SOURCE=1 -DHAVE_HIDDEN -c "$src/zlib/$name.c" -o "$src/zlib/$name.o"
  objects+=("$src/zlib/$name.o")
done
wasixar rcsD "$deps/usr/lib/libz.a" "${objects[@]}"
cp "$src/zlib/zlib.h" "$src/zlib/zconf.h" "$deps/usr/include/"

# OpenSSL, the libraries alone, without what WASIX lacks (assembly, PIC,
# loadable modules and engines, secure memory, datagrams, AF_ALG). No
# prefix map: it compiles by relative paths, and keeps its flags in the
# library (`openssl version -f`).
jobs="${CARGO_BUILD_JOBS:-$(nproc)}"
tar -xzf "$(download "$OPENSSL_URL" "$OPENSSL_SHA256" openssl.tar.gz)" -C "$src/openssl" --strip-components=1
(
  cd "$src/openssl"
  CC=wasixcc AR=wasixar RANLIB=wasixranlib SOURCE_DATE_EPOCH="$BUILT_ON_EPOCH" ./Configure linux-generic32 \
    no-asm no-pic no-shared no-dso no-module no-engine no-tests no-apps no-docs no-afalgeng no-dgram \
    no-secure-memory no-ui-console --prefix=/usr --openssldir=/etc/ssl --libdir=lib
  SOURCE_DATE_EPOCH="$BUILT_ON_EPOCH" make -j"$jobs" build_libs
  make install_dev DESTDIR="$deps"
) >"$work/openssl.log" 2>&1 || {
  tail -n 40 "$work/openssl.log" >&2
  exit 1
}

# libcurl, for HTTP, HTTPS and FTP, with the CA bundle above and without the
# protocols and libraries Git does not use. Name lookups block (WASIX has
# getaddrinfo); there is no threaded resolver to start.
tar -xJf "$(download "$CURL_URL" "$CURL_SHA256" curl.tar.xz)" -C "$src/curl" --strip-components=1
(
  cd "$src/curl"
  CC=wasixcc AR=wasixar RANLIB=wasixranlib CFLAGS="-O2 $map" CPPFLAGS="-I$deps/usr/include" \
    LDFLAGS="-L$deps/usr/lib" ./configure --host=wasm32-unknown-wasi --prefix=/usr \
    --disable-shared --enable-static --with-openssl="$deps/usr" --with-zlib="$deps/usr" \
    --with-ca-bundle="$CA_BUNDLE" --without-ca-path --without-ca-fallback \
    --without-libpsl --without-brotli --without-zstd --without-nghttp2 --without-libidn2 \
    --without-libssh2 --without-librtmp --disable-ldap --disable-ldaps --disable-rtsp --disable-dict \
    --disable-telnet --disable-tftp --disable-pop3 --disable-imap --disable-smb --disable-smtp \
    --disable-gopher --disable-mqtt --disable-manual --disable-docs --disable-unix-sockets \
    --disable-ntlm --disable-kerberos-auth --disable-threaded-resolver --disable-netrc
  make -j"$jobs" -C lib
  make -C lib install DESTDIR="$deps"
  make -C include install DESTDIR="$deps"
) >"$work/curl.log" 2>&1 || {
  tail -n 40 "$work/curl.log" >&2
  exit 1
}

# 3. Git, installed into a staging directory.
tar -xJf "$(download "$GIT_URL" "$GIT_SHA256" git.tar.xz)" -C "$src/git" --strip-components=1
for patch in "${GIT_PATCHES[@]}"; do
  patch -s -d "$src/git" -p1 <"$self/$patch"
done
stage="$work/stage"
rm -rf "$stage"
make -C "$src/git" -j"$jobs" "${MAKE_ARGS[@]}" \
  CFLAGS="-O2 -DSPAWN_WITHOUT_FORK -DEXEC_BIT_UNRELIABLE -DNO_HARD_LINKS $map -I$deps/usr/include" \
  LDFLAGS="-L$deps/usr/lib" CURL_CFLAGS="-I$deps/usr/include" \
  CURL_LDFLAGS="-L$deps/usr/lib -lcurl -lssl -lcrypto -lz" DESTDIR="$stage" install >"$work/git.log" 2>&1 || {
  tail -n 60 "$work/git.log" >&2
  exit 1
}

# 4. The package: the modules (without debug information, optimised once),
#    the scripts and programs of libexec/git-core, the templates and the CA
#    certificates.
package="$work/package"
rm -rf "$package"
mkdir -p "$package/modules" "$package/libexec/git-core" "$package/share/git-core"
wasm-opt -O2 --emit-exnref --strip-debug --strip-producers -o "$package/modules/git" "$stage/usr/bin/git"
wasm-opt -O2 --emit-exnref --strip-debug --strip-producers -o "$package/modules/git-remote-http" \
  "$stage/usr/libexec/git-core/git-remote-http"
# Everything there that is not WebAssembly: the scripts, the shell
# libraries they source (git-sh-setup), mergetools/, and the stubs that say
# a Perl or Python command is not built.
for file in "$stage/usr/libexec/git-core/"*; do
  if [[ -d "$file" ]]; then
    cp -R "$file" "$package/libexec/git-core/"
  elif [[ "$(head -c 4 "$file" | od -An -tx1 | tr -d ' \n')" != 0061736d ]]; then
    cp "$file" "$package/libexec/git-core/"
  fi
done
for name in "${LIBEXEC_PROGRAMS[@]}"; do
  wasm-opt -O2 --emit-exnref --strip-debug --strip-producers \
    -o "$package/libexec/git-core/$name" "$stage/usr/libexec/git-core/$name"
done
cp -R "$stage/usr/share/git-core/templates" "$package/share/git-core/"
cp "$src/git/COPYING" "$package/share/git-core/COPYING"
# The bundle libcurl reads, at $CA_BUNDLE (the /usr/share/git-core volume).
cp "$(download "$CACERT_URL" "$CACERT_SHA256" cacert.pem)" "$package/share/git-core/$(basename "$CA_BUNDLE")"
{
  cat <<'TOML'
[package]
entrypoint = "git"

[fs]
"/usr/libexec/git-core" = "./libexec/git-core"
"/usr/share/git-core" = "./share/git-core"

[[module]]
name = "git"
source = "./modules/git"

[[module]]
name = "git-remote-http"
source = "./modules/git-remote-http"
TOML
  for command in "${COMMANDS[@]}" "${REMOTE_COMMANDS[@]}"; do
    module=git
    [[ "$command" == git-remote-* ]] && module=git-remote-http
    cat <<TOML

[[command]]
name = "$command"
module = "$module"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
atom = "$module"
TOML
  done
} >"$package/wasmer.toml"
# A webc records each file's modification time.
find "$package" -exec env TZ=UTC0 touch -h -t "$BUILT_ON" {} +
out="$(out_dir package git "$VERSION")"
export WASMER_DIR="$work/wasmer-home"
"$tc/wasmer/bin/wasmer" package build --quiet -o "$out/git.webc" "$package"

echo "built $out/git.webc"
for module in "$package"/modules/*; do
  echo "  $(basename "$module")  $(sha256sum "$module" | cut -d' ' -f1) ($(wc -c <"$module") bytes)"
done
echo "  package $(sha256sum "$out/git.webc" | cut -d' ' -f1)"
