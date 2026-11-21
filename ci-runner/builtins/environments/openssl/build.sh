#!/usr/bin/env bash
# OpenSSL's command line for the `bash` and `bash-node` environments: the
# OpenSSL 3.5.9 git/build.sh builds Git's HTTPS on, with its `openssl`
# program, built for WASIX with wasixcc (wasix-toolchain.sh), as
# `iwci/openssl` (`openssl` on PATH).
#
# The package carries /etc/ssl, the OPENSSLDIR it is built with:
# openssl.cnf, OpenSSL's own default configuration (what `openssl req`
# reads its distinguished name and extensions from; the environments also
# set OPENSSL_CONF to it), and cert.pem, Mozilla's CA certificates as
# curl.se extracts them (the bundle git/build.sh pins), which `openssl
# s_client -verify_return_error` and the rest verify against by default.
#
# Built without what WASIX lacks, as Git's libraries are: assembly, PIC,
# loadable modules and engines, secure memory, datagrams (DTLS), AF_ALG and
# the console UI (passphrases come from `-pass`, `-passin` and `-passout`,
# not a prompt), and fork() (HAVE_FORK=0: no `ocsp -port` or `cmp -port`
# daemon and no `speed -multi`).
#
# One patch, openssl-addrconfig.patch (OPENSSL_NO_AI_ADDRCONFIG): a
# client's name lookup (`s_client -connect host:port`) asked getaddrinfo()
# for AI_ADDRCONFIG, which the C library answers by connecting a UDP socket
# to each loopback address. A job cannot, so every lookup failed with
# EAI_SYSTEM ("Not supported") and OpenSSL, which retries without the flag
# only on other errors, gave up. Without it, lookups return both families
# as they do with `-4` or `-6`.
#
# Every input is pinned by content hash, and the build is reproducible: the
# same bytes every time, which `environments/build.sh` checks against the
# hash it pins. OpenSSL compiles by relative paths and is given the
# tarball's date as SOURCE_DATE_EPOCH, and the package's files carry that
# date. The result goes to dist/package/openssl/<version>/.
#
# Linux, x86_64 or aarch64. About five minutes on four cores.
# OPENSSL_WORK keeps the downloads and the toolchain somewhere of your
# choosing (default: a scratch directory removed on exit).
#
# Needs: bash, curl, git, make, patch, perl, sha256sum, tar.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Our build of OpenSSL 3.5.9. A changed build is a new number after `iwci.`.
VERSION="3.5.9-iwci.1"
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
CACERT_URL="https://curl.se/ca/cacert-2026-11-05.pem"
CACERT_SHA256="427c064216761a1e72a8b30f0d954d08cb6e4435a82091fb865afd20c8497285"
# The date git/build.sh builds OpenSSL with, so `openssl version -b` says
# the same in both.
BUILT_ON="202611101749.00" # touch -t, in UTC
BUILT_ON_EPOCH=1794332940

work="${OPENSSL_WORK:-$SCRATCH/openssl}"
# shellcheck source=builtins/environments/wasix-toolchain.sh
source "$self/../wasix-toolchain.sh"

src="$work/src"
rm -rf "$src"
mkdir -p "$src"
tar -xzf "$(download "$OPENSSL_URL" "$OPENSSL_SHA256" openssl.tar.gz)" -C "$src" --strip-components=1
patch -s -d "$src" -p1 <"$self/openssl-addrconfig.patch"
jobs="${CARGO_BUILD_JOBS:-$(nproc)}"
(
  cd "$src"
  CC=wasixcc AR=wasixar RANLIB=wasixranlib SOURCE_DATE_EPOCH="$BUILT_ON_EPOCH" ./Configure linux-generic32 \
    no-asm no-pic no-shared no-dso no-module no-engine no-tests no-docs no-afalgeng no-dgram \
    no-secure-memory no-ui-console --prefix=/usr --openssldir=/etc/ssl --libdir=lib -DHAVE_FORK=0 -DOPENSSL_NO_AI_ADDRCONFIG
  SOURCE_DATE_EPOCH="$BUILT_ON_EPOCH" make -j"$jobs" build_programs
) >"$work/openssl.log" 2>&1 || {
  tail -n 60 "$work/openssl.log" >&2
  exit 1
}

package="$work/package"
rm -rf "$package"
mkdir -p "$package/modules" "$package/etc/ssl/certs" "$package/etc/ssl/private"
wasm-opt -O2 --emit-exnref --strip-debug --strip-producers -o "$package/modules/openssl" "$src/apps/openssl"
cp "$src/apps/openssl.cnf" "$package/etc/ssl/openssl.cnf"
cp "$(download "$CACERT_URL" "$CACERT_SHA256" cacert.pem)" "$package/etc/ssl/cert.pem"
cp "$src/LICENSE.txt" "$package/etc/ssl/LICENSE.txt"
cat >"$package/wasmer.toml" <<'TOML'
[package]
entrypoint = "openssl"

[fs]
"/etc/ssl" = "./etc/ssl"

[[module]]
name = "openssl"
source = "./modules/openssl"

[[command]]
name = "openssl"
module = "openssl"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
atom = "openssl"
TOML
# A webc records each file's modification time.
find "$package" -exec env TZ=UTC0 touch -h -t "$BUILT_ON" {} +
out="$(out_dir package openssl "$VERSION")"
export WASMER_DIR="$work/wasmer-home"
"$tc/wasmer/bin/wasmer" package build --quiet -o "$out/openssl.webc" "$package"

echo "built $out/openssl.webc"
echo "  openssl  $(sha256sum "$package/modules/openssl" | cut -d' ' -f1) ($(wc -c <"$package/modules/openssl") bytes)"
echo "  package $(sha256sum "$out/openssl.webc" | cut -d' ' -f1)"
