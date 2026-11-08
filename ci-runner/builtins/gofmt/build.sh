#!/usr/bin/env bash
# builtin:gofmt: Go's own cmd/gofmt, built for wasip1 by the Go toolchain.
# gofmt is pure Go and only reads and writes files, which is exactly what
# WASI preview 1 gives it, so it runs unmodified over the job's file system.
# Its version is the Go release it comes from.
#
# Needs: a Go toolchain (any version; GOTOOLCHAIN fetches the pinned one).
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

GO_VERSION="${GO_VERSION:-1.27.3}"
out="$(out_dir builtin gofmt "$GO_VERSION")"

# -trimpath keeps the builder's paths out of the module, so two builders
# produce the same bytes and the same hash.
GOTOOLCHAIN="go$GO_VERSION" GOOS=wasip1 GOARCH=wasm \
  go build -trimpath -ldflags=-buildid= -o "$out/module.wasm" cmd/gofmt

cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "gofmt",
  "version": "$GO_VERSION",
  "abi": "wasi",
  "module": "module.wasm",
  "description": "gofmt from Go $GO_VERSION"
}
JSON
echo "built $out"
