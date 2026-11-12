#!/usr/bin/env bash
# bash for the `env:` environments: Wasmer's `wasmer/bash` 1.0.25 with its
# `execve` passing the argument and environment lists as lists (#1003).
#
# The C library linked into that module predates `proc_exec4`. Its `execve`
# joins `argv` into one string with a line feed after each argument and
# hands that to `proc_exec3`, which splits it at line feeds again, so an
# argument with a line feed in it reached the program as several: a
# multi-line `node -e`, `python -c` or `bash -c` ran only its first line.
# Every program bash runs is started by that `execve` (bash forks, then
# execs), so every `run:` script met it. No release of `wasmer/bash` is
# built on a newer C library, and rebuilding bash on one changes its fork,
# signals and job control along with it.
#
# So this changes that one call, in the published module, and nothing else.
# `proc_exec4` takes the same nine arguments as `proc_exec3`, with the two
# lists as arrays of string pointers and their lengths as counts instead of
# joined strings and byte lengths. `execve(path, argv, envp)` still has
# `argv` and `envp` in its parameters when it makes the call, and the
# module has a function that counts a null-terminated pointer array, so the
# change is nine bytes in seven places, none changing a length:
#
#   - the import's name, `proc_exec3` to `proc_exec4`;
#   - the two lengths: `strlen(args)` and `strlen(envs)` become that
#     counting function of `argv` and `envp`;
#   - the two lists in the call: the joined strings become `argv` and `envp`.
#
# `execve` still builds the joined strings, which nothing reads any more.
# Each site is checked for the bytes it should hold before it is changed,
# and the module's hash before and after, so a different input fails here
# rather than building something nobody looked at. The disassembly the
# offsets come from (`wasm-objdump -d`, function 250, the only caller of
# `proc_exec3`):
#
#   040c55: 20 0a     local.get 10 (args)   -> 20 01  local.get 1 (argv)
#   040c57: 10 e3 0c  call 1635 (strlen)    -> 10 c8 07  call 968 (count)
#   040c5c: 20 08     local.get 8 (envs)    -> 20 02  local.get 2 (envp)
#   040c5e: 10 e3 0c  call 1635 (strlen)    -> 10 c8 07  call 968 (count)
#   040c7a: 20 0a     local.get 10 (args)   -> 20 01  local.get 1 (argv)
#   040c7e: 20 08     local.get 8 (envs)    -> 20 02  local.get 2 (envp)
#
# Function 968 is `i = -1; do { i++; } while (*p++); return i`, with no
# calls, so asyncify left it alone. Locals 1 and 2 are `execve`'s `argv` and
# `envp` parameters, which nothing assigns before the call. bash's other
# commands (sed, grep, coreutils, findutils, Edge.js) start programs with
# `proc_spawn2`/`proc_spawn3`/`proc_exec4` on their own, and are unchanged.
#
# The module goes back into the published package with the Wasmer CLI, as
# `edgejs/build.sh` does it, which records each file's hash for the runtime's
# module cache. Drop this directory, and pin Wasmer's package again, once a
# `wasmer/bash` release is built on a C library whose `execve` calls
# `proc_exec4`.
#
# Linux (x86_64 or arm64) or macOS on arm64: the Wasmer CLI's release
# archives. The result goes to dist/package/bash/<version>/, and is the same
# bytes on each: `environments/build.sh` pins its hash.
#
# Needs: bash, curl, tar, sha256sum or shasum, od, dd.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"

# Our build of 1.0.25. A changed build is a new number after `iwci.`.
VERSION="1.0.25-iwci.1"
WEBC_SHA256="059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1"
MODULE_SHA256="5b37a9f95fca50f55024b7fc37b786fa80024e55320266cb19936729d24c70ce"
PATCHED_SHA256="c31996f7570dc0367bb8f7cbab55e9af1a2f4bea51ee3c9f6a278917b731f033"
# The time every file in the package is said to have been modified: the
# module's release (wasix-org/bash `fc8096485478`, Release 1.0.25).
BUILT_ON="202602171016.51" # touch -t, in UTC

# offset (hex), the bytes there (hex), what they become. The first is the
# import's name in the import section, `proc_exec3` to `proc_exec4`.
PATCHES=(
  "0x71b 70726f635f6578656333 70726f635f6578656334"
  "0x40c55 200a 2001"
  "0x40c57 10e30c 10c807"
  "0x40c5c 2008 2002"
  "0x40c5e 10e30c 10c807"
  "0x40c7a 200a 2001"
  "0x40c7e 2008 2002"
)

WASMER_VERSION="v7.4.2"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    WASMER_ASSET="wasmer-linux-amd64.tar.gz"
    WASMER_SHA256="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
    ;;
  Linux-aarch64 | Linux-arm64)
    WASMER_ASSET="wasmer-linux-aarch64.tar.gz"
    WASMER_SHA256="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"
    ;;
  Darwin-arm64)
    WASMER_ASSET="wasmer-darwin-arm64.tar.gz"
    WASMER_SHA256="c6b555b32619321bc6d0ce34f9119d34ada07e7a0b1d3588082c165e76e8536e"
    ;;
  *)
    echo "error: no pinned Wasmer CLI for $(uname -s)-$(uname -m) (Linux x86_64 or arm64, macOS arm64)" >&2
    exit 1
    ;;
esac

work="${BASH_WORK:-$SCRATCH/bash}"
mkdir -p "$work/dl"

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# download <url> <sha256> <file>: fetched once, checked every time.
download() {
  local url="$1" sha="$2" file="$work/dl/$3" actual
  [[ -f "$file" ]] || curl -fsSL --retry 3 -o "$file" "$url"
  actual="$(sha256 "$file")"
  if [[ "$actual" != "$sha" ]]; then
    echo "error: $url hashed to $actual, expected $sha" >&2
    rm -f "$file"
    exit 1
  fi
  printf '%s\n' "$file"
}

# bytes_at <file> <offset> <count>: those bytes as lowercase hex.
bytes_at() {
  od -An -v -tx1 -j "$(($2))" -N "$3" "$1" | tr -d ' \n'
}

# put_bytes <file> <offset> <hex>: overwrite in place.
put_bytes() {
  local hex="$3" escaped="" i
  for ((i = 0; i < ${#hex}; i += 2)); do
    escaped+="\\x${hex:i:2}"
  done
  # shellcheck disable=SC2059 # the format is the bytes, built just above
  printf "$escaped" | dd of="$1" bs=1 seek="$(($2))" conv=notrunc status=none
}

wasmer="$work/wasmer"
rm -rf "$wasmer"
mkdir -p "$wasmer"
tar -xzf "$(download "https://github.com/wasmerio/wasmer/releases/download/$WASMER_VERSION/$WASMER_ASSET" \
  "$WASMER_SHA256" "$WASMER_ASSET")" -C "$wasmer"
export WASMER_DIR="$work/wasmer-home"

package="$work/package"
rm -rf "$package"
"$wasmer/bin/wasmer" package unpack --quiet -o "$package" \
  "$(download "https://cdn.wasmer.io/webcimages/$WEBC_SHA256.webc" "$WEBC_SHA256" bash.webc)"
module="$package/modules/bash"
if [[ "$(sha256 "$module")" != "$MODULE_SHA256" ]]; then
  echo "error: the published package's \`bash\` module is not the one expected" >&2
  exit 1
fi

for entry in "${PATCHES[@]}"; do
  read -r offset old new <<<"$entry"
  if [[ "$(bytes_at "$module" "$offset" $((${#old} / 2)))" != "$old" ]]; then
    echo "error: the module does not hold $old at $offset" >&2
    exit 1
  fi
  put_bytes "$module" "$offset" "$new"
done
built="$(sha256 "$module")"
if [[ "$built" != "$PATCHED_SHA256" ]]; then
  echo "error: the patched module hashed to $built, expected $PATCHED_SHA256" >&2
  exit 1
fi

# A webc records each file's modification time, which unpacking just set to
# now.
find "$package" -exec env TZ=UTC0 touch -h -t "$BUILT_ON" {} +
out="$(out_dir package bash "$VERSION")"
"$wasmer/bin/wasmer" package build --quiet -o "$out/bash.webc" "$package"

echo "built $out/bash.webc"
echo "  module  $built"
echo "  package $(sha256 "$out/bash.webc")"
