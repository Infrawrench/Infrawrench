#!/usr/bin/env bash
# builtin:typescript, the type checker: tsc-rs (github.com/pingdotgg/ts-rust,
# a Rust port of TypeScript 7) built for wasm32-wasip1 by its own
# scripts/wasm/build.sh. The module reads files through two host imports
# (`ts_host.fs`, `ts_host.fs_take`) rather than WASI's file system, so its
# manifest says `abi: tsc-host` and the runner serves those imports straight
# from the job's in-memory file system.
#
# The builtin's version is the TypeScript version the compiler reports
# (`tsc --version`), not the tsc-rs release, because that is what a user
# pins: tsc-rs 0.8.0 reports 7.1.0-dev and publishes as 7.1.0.
#
# Needs: git, rustup with wasm32-wasip1, binaryen's wasm-opt 132+, node.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

TSC_RS_TAG="${TSC_RS_TAG:-v0.8.0}"
TS_VERSION="${TS_VERSION:-7.1.0}"

src="$SCRATCH/ts-rust"
git clone --depth 1 --branch "$TSC_RS_TAG" https://github.com/pingdotgg/ts-rust.git "$src"
out="$(out_dir builtin typescript "$TS_VERSION")"

# The faster of the two documented builds (13 to 18% quicker checks for 1 MB
# more): a CI run checks far more than it downloads, and the module is
# compiled once and cached by the runner anyway.
(
  cd "$src" || exit 1
  CARGO_PROFILE_WASM_OPT_LEVEL=s \
    WASM_RUSTFLAGS="-C llvm-args=-inlinehint-threshold=150" \
    scripts/wasm/build.sh "$out/module.wasm"
)

cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "typescript",
  "version": "$TS_VERSION",
  "abi": "tsc-host",
  "module": "module.wasm",
  "description": "TypeScript $TS_VERSION type checker (tsc-rs $TSC_RS_TAG)"
}
JSON
echo "built $out"
