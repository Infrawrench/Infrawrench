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
# The `ignore` crate's parallel walker, which oxfmt uses to walk a
# directory, has placeholders that fail with "unsupported platform" on
# anything but Unix and Windows, so on WASIX `oxfmt .` found no files.
# ignore-wasi.patch fills them in (an entry from its `read_dir` entry or its
# metadata; there is no inode to keep). The build fetches the exact version
# Oxc locks, checks it against the lock's checksum, patches it and points
# Cargo at the copy; the patch fails to apply if Oxc moves to a version it
# does not fit, which is the cue to look again.
#
# Needs: git, curl, patch, cargo-wasix (`cargo install cargo-wasix`; it installs the
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
# Both crates also build a `cdylib` (the addon itself), which Cargo builds
# even for a dependency and which cannot link for this target, so they are
# trimmed to `lib`.
for crate in apps/oxfmt crates/oxc_napi; do
  printf 'fn main() {}\n' >"$src/$crate/build.rs"
  manifest="$src/$crate/Cargo.toml"
  sed 's/^crate-type = \["lib", "cdylib"\]$/crate-type = ["lib"]/' "$manifest" >"$manifest.new"
  if cmp -s "$manifest" "$manifest.new"; then
    echo "error: $crate no longer declares crate-type [\"lib\", \"cdylib\"]; recheck this patch" >&2
    exit 1
  fi
  mv "$manifest.new" "$manifest"
done

lock_field() { # lock_field <crate> <field>: from the first entry for <crate>
  awk -v name="$1" -v field="$2" '
    $0 == "name = \"" name "\"" { found = 1; next }
    found && $1 == field { gsub(/"/, "", $3); print $3; exit }
  ' "$src/Cargo.lock"
}
ignore_version="$(lock_field ignore version)"
ignore_sha256="$(lock_field ignore checksum)"
curl -fsSL --retry 3 -o "$SCRATCH/ignore.crate" \
  "https://static.crates.io/crates/ignore/ignore-$ignore_version.crate"
if [[ "$(shasum -a 256 "$SCRATCH/ignore.crate" | cut -d' ' -f1)" != "$ignore_sha256" ]]; then
  echo "error: ignore $ignore_version does not match Oxc's Cargo.lock" >&2
  exit 1
fi
tar -xzf "$SCRATCH/ignore.crate" -C "$SCRATCH"
patch -d "$SCRATCH/ignore-$ignore_version" -p1 <"$here/oxfmt/ignore-wasi.patch"

(
  cd "$src" || exit 1
  CARGO_WASIX_NO_REGISTRY_CONFIG=1 \
    RUSTFLAGS="-C target-feature=+atomics,+simd128,+relaxed-simd,+extended-const --cfg tokio_unstable" \
    cargo wasix build --release -p oxfmt --bin oxfmt --no-default-features \
    --config "patch.crates-io.ignore.path=\"$SCRATCH/ignore-$ignore_version\""
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
