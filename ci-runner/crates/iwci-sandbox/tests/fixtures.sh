#!/usr/bin/env bash
# The inputs of the gVisor tests (tests/gvisor.rs), pinned and verified:
#
#   fixtures.sh <dir>
#
# leaves <dir>/gvisor (the unpacked gVisor release) and <dir>/bunroot (Bun
# and the C library it links, laid out as they go in the sandbox), and
# prints the environment the tests read. The C library is the host's: the
# job's own glibc set is pinned by the Bun builtin, not here. busybox comes
# from the host too (Ubuntu's busybox-static).
set -euo pipefail

out=${1:?usage: fixtures.sh <dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)

# gVisor publishes a SHA-512 next to each release archive.
GVISOR_RELEASE=20261109.0
# Bun's release carries SHASUMS256.txt.
BUN_VERSION=1.4.4

case "$(uname -m)" in
x86_64)
  gvisor_arch=x86_64
  gvisor_sha512=1a6b8f74c37b4931ef473f67ec1f601690855bedc52ac709f2fac965c69677aa0426ef44598d8eee1aed72cfdb9df87a2a5f352cb3348880fc61a7732bc10f2a
  bun_asset=bun-linux-x64
  bun_sha256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
  loader=/lib64/ld-linux-x86-64.so.2
  libdir=/lib/x86_64-linux-gnu
  ;;
aarch64)
  gvisor_arch=aarch64
  gvisor_sha512=411f2d6f7f98a93643725ce9933ff67a7f96f884c2317be3e2b579b976ceb54065bd1d4292a9d61de38da1940ef21b7e41070127874086b7992fb7b5e7a85897
  bun_asset=bun-linux-aarch64
  bun_sha256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
  loader=/lib/ld-linux-aarch64.so.1
  libdir=/lib/aarch64-linux-gnu
  ;;
*)
  echo "fixtures.sh: no pins for $(uname -m)" >&2
  exit 1
  ;;
esac

dl="$out/downloads"
mkdir -p "$dl"

if [ ! -x "$out/gvisor/gvisor-bin/gvisor_sentry" ]; then
  curl -fsSL --retry 3 -o "$dl/gvisor.tar.bz2" \
    "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/$gvisor_arch/gvisor.tar.bz2"
  echo "$gvisor_sha512  $dl/gvisor.tar.bz2" | sha512sum -c --quiet
  rm -rf "$out/gvisor"
  mkdir -p "$out/gvisor"
  tar -xjf "$dl/gvisor.tar.bz2" -C "$out/gvisor"
fi

if [ ! -x "$out/bunroot/usr/local/bin/bun" ]; then
  curl -fsSL --retry 3 -o "$dl/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$bun_asset.zip"
  echo "$bun_sha256  $dl/bun.zip" | sha256sum -c --quiet
  rm -rf "$out/bunroot" "$dl/bun"
  python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$dl/bun.zip" "$dl/bun"
  install -D -m 0755 "$dl/bun/$bun_asset/bun" "$out/bunroot/usr/local/bin/bun"
  install -D -m 0755 "$(readlink -f "$loader")" "$out/bunroot$loader"
  for lib in libc.so.6 libpthread.so.0 libdl.so.2 libm.so.6; do
    install -D -m 0644 "$(readlink -f "$libdir/$lib")" "$out/bunroot$libdir/$lib"
  done
fi

rm -rf "$dl"
echo "IWCI_TEST_GVISOR=$out/gvisor"
echo "IWCI_TEST_BUN_ROOT=$out/bunroot"
