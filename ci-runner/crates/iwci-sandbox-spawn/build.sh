#!/usr/bin/env bash
# Builds the sandbox service as the runner hosts install it: static, against
# the musl C library the Rust toolchain ships and linked by the toolchain's
# own linker, for x86_64 and aarch64, from any x86_64 Linux machine:
#
#   crates/iwci-sandbox-spawn/build.sh [--check]
#     -> target/<arch>-unknown-linux-musl/release/iwci-sandbox-spawn
#
# (under CARGO_TARGET_DIR when it is set). Nothing of the machine it runs on
# goes in (its C library, its linker, its paths), so the same sources and
# toolchain give the same bytes on any x86_64 machine (the toolchain's
# host goes into the symbols, so an aarch64 machine's build differs): `sha256` beside this script
# records them per architecture, as `<arch> <sha256>` lines, and
# infra/ci-runners installs a service only if it matches. It prints the
# same lines for this build, then each binary's path; with `--check` it
# fails when they differ from `sha256`.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
if [[ "$(uname -m)" != x86_64 ]]; then
  echo "build.sh: build on x86_64 Linux, where the pins were made" >&2
  exit 1
fi
root="$(pwd -P)"
cargo_home="$(realpath "${CARGO_HOME:-$HOME/.cargo}")"
target_dir="$(realpath -m "${CARGO_TARGET_DIR:-target}")"
lines=()
paths=()
for arch in x86_64 aarch64; do
  triple="$arch-unknown-linux-musl"
  rustup target list --installed | grep -qx "$triple" || rustup target add "$triple" >&2
  RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes --remap-path-prefix=$root=/build --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$target_dir=/target" \
    cargo build --release -p iwci-sandbox-spawn --target "$triple" >&2
  binary="$target_dir/$triple/release/iwci-sandbox-spawn"
  if ! file "$binary" | grep -q 'statically linked\|static-pie linked'; then
    echo "build.sh: $binary is not static: $(file "$binary")" >&2
    exit 1
  fi
  lines+=("$arch $(sha256sum "$binary" | cut -d' ' -f1)")
  paths+=("$binary")
done
printf '%s\n' "${lines[@]}"
if [[ "${1:-}" == "--check" ]] && ! diff <(printf '%s\n' "${lines[@]}") crates/iwci-sandbox-spawn/sha256 >&2; then
  echo "build.sh: these builds are not the ones crates/iwci-sandbox-spawn/sha256 pins" >&2
  exit 1
fi
printf '%s\n' "${paths[@]}"
