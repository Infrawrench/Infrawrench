#!/usr/bin/env bash
# builtin:ssh, builtin:scp, builtin:sftp, builtin:ssh-keygen and
# builtin:ssh-keyscan: OpenSSH portable's client programs, built from the
# release tarball for WASIX, one module each, so `tools: [builtin:ssh@10.6]`
# puts the real `ssh` on a job's PATH, reading the ~/.ssh/config,
# known_hosts and keys a lent connection or SSH key writes. No sshd, agent
# or helpers: a job has nothing to serve.
#
# Built with OpenSSL, so RSA and ECDSA keys work as well as Ed25519, and
# every cipher, MAC and key exchange OpenSSH has (ML-KEM and sntrup761 are
# its own code either way). No zlib: `Compression yes` is refused, and
# OpenSSH 10.6 stopped compressing with back references anyway.
#
# Two patches to OpenSSH's source, every change inside `#ifdef __wasi__`,
# so the rest builds as anywhere:
#
#   openssh-spawn.patch. The C library below (the one Edge.js and Git are
#     linked with, which has wasm exception handling) has no fork(). Where
#     a client forks and execs, it now calls spawn_command() (misc.c), a
#     posix_spawn() with the same descriptors: ProxyCommand and ProxyJump
#     (which runs `ssh -W` as a ProxyCommand), scp and sftp starting ssh,
#     LocalCommand, `Match exec`, scp's local copies and sftp's `!`. What
#     else forks (`ssh -f`, ControlPersist, KnownHostsCommand, askpass)
#     fails with "Function not implemented" through a fork() that says so.
#
#   openssh-wasix-libc.patch. Three gaps in that C library: ppoll() is built
#     on poll() (pselect() is a stub that fails with ENOSYS, and poll()
#     fails with ENOSYS for an entry waiting for neither input nor output,
#     which ssh's channel loop passes), getrrsetbyname() finds no SSHFP
#     records (there is no res_query()), and madvise() is not called.
#
# Configure is told what WASIX lacks rather than patched: no file
# descriptor passing (ProxyUseFdpass), no getifaddrs() (`Match
# localnetwork`, BindInterface), no IP_TOS, pipes for scp and sftp, and an
# empty resolv.h (OpenSSH includes it for base64, which it supplies).
#
# Key permissions are checked as on Linux: the C library carries
# edgejs/wasix-libc-modes.patch, so a private key a job wrote without
# `chmod 600` is refused as "UNPROTECTED PRIVATE KEY FILE", and the lent
# ones (0600) are not.
#
# Also builds, for builtins/test.sh, the small SSH server its jobs connect
# to (`sshd-fixture/`, in Go with env:go's toolchain) into
# dist/test/openssh/. It is not shipped.
#
# Every input is pinned by content hash, and the build is reproducible:
# each module must come out with the sha256 pinned below, or the build
# fails rather than publish other bytes. The toolchain, the C library and
# its patches, and OpenSSL are read from environments/git/build.sh, and the
# Go release from environments/go/build.sh, so each is pinned in one place.
#
# Linux, x86_64 or aarch64. A few minutes, about 1 GB of downloads and 2 GB
# of disk. OPENSSH_WORK keeps the downloads and the toolchains somewhere of
# your choosing (default: a scratch directory removed on exit).
#
# Needs: bash, curl, git, make, perl, sha256sum, tar.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Our build of OpenSSH 10.6p2. The patch number is our revision, not
# OpenSSH's: a changed build is the next one (10.6.1), and a new OpenSSH
# minor starts again at 0.
VERSION="10.6.0"
OPENSSH_RELEASE="10.6p2"
# The portable release, as published with its signature (checked once by
# hand against Damien Miller's key, 7168B983815A5EEF59A4ADFD2A3F414E736060BA).
OPENSSH_URL="https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-$OPENSSH_RELEASE.tar.gz"
OPENSSH_SHA256="9ae44872090cf2f06b3cf9ff147e7f16f309671340763ed2f99248398ae29d5b"
# The tarball's date: OpenSSL's "built on" (SOURCE_DATE_EPOCH).
BUILT_ON_EPOCH=1793836646
# Applied in this order (see the top of this file).
PATCHES=(openssh-spawn.patch openssh-wasix-libc.patch)
# Each program and the sha256 its module must come out with.
PROGRAMS=(
  "ssh 1b035b8f8d7d85a5c0aec070959c74ac4d809f9165f89ae4b1143326c78f6ead"
  "scp 26ede1696a3c1aa96d0825edfc168e37b2f19ef9c6ae06bb6a1c68b721ebd936"
  "sftp 8389e4739c8d4badd91379fdf945d8589916b1be957dd0b6a39a7b1867274104"
  "ssh-keygen a133fb2787e70c7b4c574a52a0e9aaf7b07928587e017f1e4bf6d9b01ba29e7d"
  "ssh-keyscan 4d30102d26a25909ef9767865b4af545d93c7acb95ab82d81b6291ba58b25007"
)
# The env:go minor whose toolchain builds the test server.
GO_MINOR=1.27

# Git's pins: the C library, its patches, the sysroot, wasixcc, LLVM and
# Binaryen for this host (the block from "The C library" to the `esac` of
# the host's archives), and OpenSSL.
git_build="$here/environments/git/build.sh"
eval "$(sed -n '/^# The C library, toolchain and Wasmer CLI/,/^esac$/p' "$git_build")"
eval "$(grep -E '^OPENSSL_(URL|SHA256)=' "$git_build")"
for name in WASIX_LIBC_REPO WASIX_LIBC_COMMIT SYSROOT_URL SYSROOT_SHA256 BINARYEN WASIXCC_URL \
  WASIXCC_SHA256 LLVM_URL LLVM_SHA256 BINARYEN_URL BINARYEN_SHA256 OPENSSL_URL OPENSSL_SHA256; do
  if [[ -z "${!name:-}" ]]; then
    echo "error: environments/git/build.sh pins no $name; this script reads its pins" >&2
    exit 1
  fi
done
if [[ ${#LIBC_PATCHES[@]} -eq 0 ]]; then
  echo "error: environments/git/build.sh lists no LIBC_PATCHES" >&2
  exit 1
fi

# env:go's pin for that minor: release, linux-amd64 and linux-arm64 hashes.
go_release="$(sed -n "s/^    ${GO_MINOR//./\\.}) echo \"\(.*\)\" ;;\$/\1/p" "$here/environments/go/build.sh")"
if [[ -z "$go_release" ]]; then
  echo "error: environments/go/build.sh pins no Go $GO_MINOR" >&2
  exit 1
fi
read -r go_version go_amd64_sha go_arm64_sha _ <<<"$go_release"
case "$(uname -m)" in
  x86_64) go_arch=amd64 go_sha="$go_amd64_sha" ;;
  *) go_arch=arm64 go_sha="$go_arm64_sha" ;;
esac

work="${OPENSSH_WORK:-$SCRATCH/openssh}"
mkdir -p "$work/dl"

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

# 1. The toolchain, laid out as wasixcc expects (as Git's build does), and
#    the C library objects rebuilt with Git's (Edge.js's) patches.
tc="$work/toolchain"
rm -rf "$tc"
mkdir -p "$tc/wasixcc" "$tc/bin" "$tc/llvm" "$tc/sysroot/sysroot-exnref-eh"
tar -xzf "$(download "$WASIXCC_URL" "$WASIXCC_SHA256" wasixcc.tar.gz)" -C "$tc/wasixcc"
"$tc/wasixcc/wasixccenv" install-executables "$tc/bin" >/dev/null
tar -xzf "$(download "$LLVM_URL" "$LLVM_SHA256" llvm.tar.gz)" -C "$tc/llvm"
tar -xzf "$(download "$BINARYEN_URL" "$BINARYEN_SHA256" binaryen.tar.gz)" -C "$tc"
tar -xzf "$(download "$SYSROOT_URL" "$SYSROOT_SHA256" sysroot-exnref-eh.tar.gz)" \
  -C "$tc/sysroot/sysroot-exnref-eh" --strip-components=2
export WASIXCC_SYSROOT_PREFIX="$tc/sysroot"
export WASIXCC_LLVM_LOCATION="$tc/llvm"
export WASIXCC_BINARYEN_LOCATION="$tc/binaryen-$BINARYEN"
export WASIXCC_WASM_EXCEPTIONS=exnref
export WASIXCC_RUN_WASM_OPT=no
export PATH="$tc/bin:$tc/binaryen-$BINARYEN/bin:$PATH"

libc="$work/wasix-libc"
archive="$tc/sysroot/sysroot-exnref-eh/lib/wasm32-wasi/libc.a"
rm -rf "$libc" "$work/check"
mkdir -p "$libc" "$work/check"
git init -q "$libc"
git -C "$libc" fetch -q --depth 1 "$WASIX_LIBC_REPO" "$WASIX_LIBC_COMMIT"
git -C "$libc" checkout -q --detach FETCH_HEAD
for entry in "${LIBC_PATCHES[@]}"; do
  patch="${entry%% *}"
  read -ra pairs <<<"${entry#* }"
  git -C "$libc" apply "$here/environments/edgejs/$patch"
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

# 2. OpenSSL's libcrypto, as Git's build makes it (the libraries alone,
#    without what WASIX lacks), installed under $deps.
deps="$work/deps"
src="$work/src"
rm -rf "$deps" "$src"
mkdir -p "$deps/usr/include" "$src/openssl" "$src/openssh"
jobs="${CARGO_BUILD_JOBS:-$(nproc)}"
# shellcheck disable=SC2153 # set from Git's pins, above
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

# 3. OpenSSH. `resolv.h` is included only for b64_ntop()/b64_pton(), which
#    openbsd-compat supplies when the C library has none; WASIX has no
#    resolver header at all.
tar -xzf "$(download "$OPENSSH_URL" "$OPENSSH_SHA256" openssh.tar.gz)" -C "$src/openssh" --strip-components=1
for patch in "${PATCHES[@]}"; do
  patch -s -d "$src/openssh" -p1 <"$self/$patch"
done
mkdir -p "$work/include"
echo '/* WASIX has no resolver; OpenSSH includes this for base64, which openbsd-compat supplies. */' \
  >"$work/include/resolv.h"
map="-ffile-prefix-map=$src/= -ffile-prefix-map=$work/="
(
  cd "$src/openssh"
  # What WASIX lacks, told to configure: msg_control is in its msghdr but
  # there is no SCM_RIGHTS (no descriptor passing), ifaddrs.h is there but
  # getifaddrs() is not, and IP_TOS cannot be set (IP_TOS_IS_BROKEN, as on
  # Cygwin). USE_PIPES: scp and sftp talk to ssh over pipes, as on most
  # platforms that have no socketpair() to spare.
  ac_cv_have_control_in_msghdr=no ac_cv_header_ifaddrs_h=no \
    CC=wasixcc AR=wasixar RANLIB=wasixranlib CFLAGS="-O2 $map" \
    CPPFLAGS="-I$work/include -I$deps/usr/include -DUSE_PIPES=1 -DIP_TOS_IS_BROKEN" \
    LDFLAGS="-L$deps/usr/lib" ./configure --host=wasm32-unknown-wasi --build="$(uname -m)-pc-linux-gnu" \
    --prefix=/usr/local --sysconfdir=/etc/ssh --with-ssl-dir="$deps/usr" --without-zlib \
    --without-pam --without-selinux --without-kerberos5 --without-libedit --without-security-key-builtin \
    --disable-security-key --disable-pkcs11 --without-shadow --disable-lastlog --disable-utmp \
    --disable-utmpx --disable-wtmp --disable-wtmpx --disable-strip
  # wasixcc moves every -l before the objects, so the linker met
  # libssh.a's cleanup_exit() before the program's own and refused the
  # pair. As paths, the archives stay after the objects.
  sed -i -e 's| -lssh\b| libssh.a|g' -e 's| -lopenbsd-compat\b| openbsd-compat/libopenbsd-compat.a|g' Makefile
  # shellcheck disable=SC2016 # the Makefile's text, variables and all
  if ! grep -qF '$(LD) -o $@ $(SSHOBJS) $(LDFLAGS) libssh.a openbsd-compat/libopenbsd-compat.a ' Makefile; then
    echo "error: ssh's link line is not what this script rewrites; check Makefile.in" >&2
    exit 1
  fi
  for entry in "${PROGRAMS[@]}"; do
    make -j"$jobs" "${entry%% *}"
  done
) >"$work/openssh.log" 2>&1 || {
  tail -n 60 "$work/openssh.log" >&2
  exit 1
}

# 4. One builtin per program, optimised once, without debug information.
status=0
for entry in "${PROGRAMS[@]}"; do
  read -r program sha <<<"$entry"
  out="$(out_dir builtin "$program" "$VERSION")"
  wasm-opt -O2 --emit-exnref --strip-debug --strip-producers -o "$out/module.wasm" "$src/openssh/$program"
  got="$(sha256sum "$out/module.wasm" | cut -d' ' -f1)"
  if [[ "$got" != "$sha" ]]; then
    echo "error: $program came out as $got, not the pinned $sha" >&2
    status=1
  fi
  cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "$program",
  "version": "$VERSION",
  "abi": "wasix",
  "module": "module.wasm",
  "description": "OpenSSH $OPENSSH_RELEASE $program for WASIX, with OpenSSL ($VERSION)"
}
JSON
  echo "built $out ($(wc -c <"$out/module.wasm") bytes, $got)"
done
[[ "$status" == 0 ]] || exit 1

# 5. The test server, with env:go's toolchain (as builtins/kubectl builds
#    its fake API server): Go's archive with env:go's series applied, the
#    modules pinned by sshd-fixture/go.sum and vendored. pkg/sftp leaves
#    wasip1 out of the build lines of two Unix files that are all it needs
#    (it lists js); they are let in, each line checked first.
archive="$(download "https://go.dev/dl/go$go_version.linux-$go_arch.tar.gz" "$go_sha" "go$go_version.linux-$go_arch.tar.gz")"
goroot="$work/go"
rm -rf "$goroot"
mkdir -p "$goroot"
tar -xzf "$archive" -C "$goroot" --strip-components=1
for patch in "$here/environments/go/$GO_MINOR"/*.patch; do
  git -C "$goroot" apply --whitespace=nowarn "$patch" || {
    echo "error: $(basename "$patch") does not apply to go$go_version" >&2
    exit 1
  }
done
hostgo() {
  env -i PATH="$goroot/bin:/usr/bin:/bin" HOME="$work/home" GOROOT="$goroot" \
    GOENV=off GOTOOLCHAIN=local GOTELEMETRY=off CGO_ENABLED=0 \
    GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
    GOCACHE="$work/gocache" GOMODCACHE="$work/modcache" GOOS=wasip1 GOARCH=wasm "$@"
}
fixture="$work/sshd-fixture"
rm -rf "$fixture"
cp -R "$self/sshd-fixture" "$fixture"
(cd "$fixture" && hostgo GOFLAGS="-mod=mod -modcacherw" go mod vendor)
# retag <file> <its build line>: the line must still be this one.
retag() {
  local path="$fixture/vendor/github.com/pkg/sftp/$1"
  if [[ "$(head -n 1 "$path")" != "$2" ]]; then
    echo "error: pkg/sftp's $1 starts with \`$(head -n 1 "$path")\`, not \`$2\`; check what changed" >&2
    exit 1
  fi
  sed -i '1s/$/ || wasip1/' "$path"
}
retag attrs_unix.go '//go:build darwin || dragonfly || freebsd || (!android && linux) || netbsd || openbsd || solaris || aix || js || zos'
retag ls_unix.go '//go:build aix || darwin || dragonfly || freebsd || (!android && linux) || netbsd || openbsd || solaris || js || zos'
test_out="$dist/test/openssh"
mkdir -p "$test_out"
(cd "$fixture" && hostgo GOFLAGS="-mod=vendor -modcacherw" go build -trimpath -ldflags="-s -w -buildid=" \
  -o "$test_out/sshd-fixture.wasm" .)
echo "built $test_out/sshd-fixture.wasm"
