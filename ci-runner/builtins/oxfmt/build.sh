#!/usr/bin/env bash
# builtin:oxfmt: the Oxc formatter's pure-Rust CLI (apps/oxfmt/src/main.rs
# in github.com/oxc-project/oxc), a Prettier-compatible formatter for
# JavaScript, TypeScript, JSON, CSS, GraphQL and YAML. It replaces Prettier
# here because Prettier is JavaScript and this runner does not embed a
# JavaScript engine for builtins; Oxc reports full conformance with
# Prettier's JS and TS tests and lists its few deliberate differences in
# apps/oxfmt/DIVERGENCES.md.
#
# It builds for WASIX (wasm32-wasmer-wasi) rather than plain WASI because
# the CLI uses a multi-threaded tokio runtime and rayon, and WASIX has
# threads. The default `napi` feature is the Node binding and is left out.
#
# cargo-wasix normally swaps crates.io for Wasmer's `wasix` index of patched
# crates, whose newest tokio (1.47) is older than Oxc requires (^1.52.3), so
# the swap is turned off and mainline crates are used. Mainline tokio
# refuses `rt-multi-thread` on wasm unless built with `--cfg tokio_unstable`.
# cargo-wasix only sets its own target features when RUSTFLAGS is unset, so
# they are repeated here (atomics is what threads need).
#
# Needs: git, cargo-wasix (`cargo install cargo-wasix`; it installs the
# WASIX toolchain on first use), and on Linux `ld.lld` on PATH (the `lld`
# package): the WASIX toolchain links host build scripts with
# `-fuse-ld=lld` but does not ship the wrapper that flag looks for.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

OXC_TAG="${OXC_TAG:-apps_v1.84.0}"
OXFMT_VERSION="${OXFMT_VERSION:-0.69.0}"

src="$SCRATCH/oxc"
git clone --depth 1 --branch "$OXC_TAG" https://github.com/oxc-project/oxc.git "$src"
actual="$(sed -n 's/^version = "\(.*\)"/\1/p' "$src/apps/oxfmt/Cargo.toml" | head -1)"
if [[ "$actual" != "$OXFMT_VERSION" ]]; then
  echo "error: $OXC_TAG has oxfmt $actual, not $OXFMT_VERSION" >&2
  exit 1
fi
out="$(out_dir builtin oxfmt "$OXFMT_VERSION")"

# The CLI is not a Node addon, but apps/oxfmt and crates/oxc_napi call
# napi_build::setup() unconditionally, and for a wasi target that links
# emnapi and turns the module into a Node-API reactor (imported memory, no
# `_start`). With the `napi` feature off nothing needs it, so both build
# scripts are emptied in the clone.
for build_rs in apps/oxfmt/build.rs crates/oxc_napi/build.rs; do
  printf 'fn main() {}\n' >"$src/$build_rs"
done

(
  cd "$src" || exit 1
  CARGO_WASIX_NO_REGISTRY_CONFIG=1 \
    RUSTFLAGS="-C target-feature=+atomics,+simd128,+relaxed-simd,+extended-const --cfg tokio_unstable" \
    cargo wasix build --release -p oxfmt --bin oxfmt --no-default-features
)
cp "$src/target/wasm32-wasmer-wasi/release/oxfmt.wasm" "$out/module.wasm"

cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "oxfmt",
  "version": "$OXFMT_VERSION",
  "abi": "wasix",
  "module": "module.wasm",
  "description": "oxfmt $OXFMT_VERSION ($OXC_TAG), Prettier-compatible"
}
JSON
echo "built $out"
