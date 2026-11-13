#!/usr/bin/env bash
# `iwci/clickhouse`, the package a future `env:clickhouse` adds to bash-node's:
# CloudHouse (ClickHouse 26.11) built for one-thread WebAssembly as the
# `clickhouse-ci` target, and server.mjs, which serves ClickHouse's HTTP
# interface from it on Node (Edge.js in a job). Its files are mounted at
# /opt/clickhouse, with `clickhouse-server` in /opt/clickhouse/bin, for a
# job's `services:`.
#
# PROTOTYPE, not wired into environments/build.sh. It packages an engine
# built elsewhere: CloudHouse with cloudhouse-ci.patch applied, configured as
# its serverless/README.md says (`-DWASM_ISOLATE=1`, emsdk 6.0.5), then
# `ninja clickhouse-ci`. Making that build reproducible here, as
# edgejs/build.sh does for Edge.js, is what remains before the environment
# can be pinned and published.
#
#   environments/clickhouse/package.sh <dir with clickhouse-ci.mjs and .wasm>
#     -> dist/package/clickhouse/<version>/clickhouse.webc
#
# Needs: curl, sha256sum, tar; Linux on x86_64 or ARM64 (for the Wasmer CLI).
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"

# The package's own version: ClickHouse's, then our revision.
VERSION="26.11.1-iwci.1"
BUILT_ON="1767225600" # 2026-01-01T00:00:00Z

engine="${1:?usage: package.sh <dir with clickhouse-ci.mjs and clickhouse-ci.wasm>}"
for file in clickhouse-ci.mjs clickhouse-ci.wasm; do
  if [[ ! -f "$engine/$file" ]]; then
    echo "error: no $engine/$file" >&2
    exit 1
  fi
done

# The Wasmer CLI, only to build the package (the same release as php-cli's).
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    WASMER_URL="https://github.com/wasmerio/wasmer/releases/download/v7.4.2/wasmer-linux-amd64.tar.gz"
    WASMER_SHA256="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
    ;;
  Linux-aarch64)
    WASMER_URL="https://github.com/wasmerio/wasmer/releases/download/v7.4.2/wasmer-linux-aarch64.tar.gz"
    WASMER_SHA256="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"
    ;;
  *)
    echo "error: clickhouse packages on Linux, x86_64 or ARM64 (for the Wasmer CLI)" >&2
    exit 1
    ;;
esac

src="$here/environments/clickhouse"
work="$SCRATCH/clickhouse"
mkdir -p "$work/wasmer"
curl -fsSL --retry 3 -o "$work/wasmer.tar.gz" "$WASMER_URL"
if ! echo "$WASMER_SHA256  $work/wasmer.tar.gz" | sha256sum -c --status -; then
  echo "error: $WASMER_URL hashed to $(sha256sum "$work/wasmer.tar.gz" | cut -d' ' -f1), expected $WASMER_SHA256" >&2
  exit 1
fi
tar -xzf "$work/wasmer.tar.gz" -C "$work/wasmer"

package="$work/package"
mkdir -p "$package/fs/bin" "$package/fs/lib"
cp "$engine/clickhouse-ci.mjs" "$engine/clickhouse-ci.wasm" "$src/server.mjs" "$package/fs/lib/"
cat >"$package/fs/bin/clickhouse-server" <<'SH'
#!/bin/bash
exec node /opt/clickhouse/lib/server.mjs "$@"
SH
cat >"$package/wasmer.toml" <<TOML
[package]
name = "iwci/clickhouse"
version = "$VERSION"
description = "CloudHouse (ClickHouse 26.11) for one-thread WebAssembly, served over ClickHouse's HTTP interface by Node"

[fs]
"/opt/clickhouse" = "fs"
TOML
chmod 0755 "$package/fs/bin/"*
chmod 0644 "$package/fs/lib/"*
find "$package" -exec touch -h -d "@$BUILT_ON" {} +

out="$(out_dir package clickhouse "$VERSION")"
WASMER_DIR="$work/wasmer-home" "$work/wasmer/bin/wasmer" package build --quiet -o "$out/clickhouse.webc" "$package"
echo "built $out/clickhouse.webc"
echo "  package $(sha256sum "$out/clickhouse.webc" | cut -d' ' -f1)"
