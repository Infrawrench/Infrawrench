# shellcheck shell=bash
# Shared by bash/build.sh and sed/build.sh, which each change a few bytes of
# the module in one of Wasmer's published packages and package it again.
# Sourced after builtins/lib.sh; defines `patch_package` and runs nothing.
#
# The module goes back into the package with the Wasmer CLI, as
# `edgejs/build.sh` does it, which records each file's hash for the
# runtime's module cache, so a webc is never edited in place. Linux (x86_64
# or arm64) or macOS on arm64: the Wasmer CLI's release archives. The result
# is the same bytes on each, which `environments/build.sh` pins.
#
# Needs: bash, curl, tar, sha256sum or shasum, od, dd.

PATCH_WASMER_VERSION="v7.4.2"

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# download <dir> <url> <sha256> <file>: fetched once, checked every time.
download() {
  local url="$2" sha="$3" file="$1/$4" actual
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

# patch_package <work> <name> <version> <webc sha256> <module sha256>
#   <patched module sha256> <built on> <patch>...
#
# Unpacks Wasmer's `wasmer/<name>` webc (the CDN file named by its sha256),
# checks that its module `modules/<name>` hashes to <module sha256>, applies
# each <patch> ("offset old new", hex bytes, the module checked to hold
# <old> there first), checks the result's hash, and packs it as
# dist/package/<name>/<version>/<name>.webc with every file dated
# <built on> (`touch -t`, UTC), since a webc records modification times.
# <work> keeps the downloads between runs.
patch_package() {
  local work="$1" name="$2" version="$3" webc_sha="$4" module_sha="$5" patched_sha="$6" built_on="$7"
  shift 7
  local asset asset_sha
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      asset="wasmer-linux-amd64.tar.gz"
      asset_sha="07271f7ecf449135bbd44cfe9f38a65e54ab25f1564a9c6bd2d0d5cca5743963"
      ;;
    Linux-aarch64 | Linux-arm64)
      asset="wasmer-linux-aarch64.tar.gz"
      asset_sha="558c522e57fea98416e63e1281b319e98946fa60325c2644ab6a900b3d618ea1"
      ;;
    Darwin-arm64)
      asset="wasmer-darwin-arm64.tar.gz"
      asset_sha="c6b555b32619321bc6d0ce34f9119d34ada07e7a0b1d3588082c165e76e8536e"
      ;;
    *)
      echo "error: no pinned Wasmer CLI for $(uname -s)-$(uname -m) (Linux x86_64 or arm64, macOS arm64)" >&2
      exit 1
      ;;
  esac
  mkdir -p "$work/dl"

  local wasmer="$work/wasmer"
  rm -rf "$wasmer"
  mkdir -p "$wasmer"
  tar -xzf "$(download "$work/dl" "https://github.com/wasmerio/wasmer/releases/download/$PATCH_WASMER_VERSION/$asset" \
    "$asset_sha" "$asset")" -C "$wasmer"
  export WASMER_DIR="$work/wasmer-home"

  local package="$work/package"
  rm -rf "$package"
  "$wasmer/bin/wasmer" package unpack --quiet -o "$package" \
    "$(download "$work/dl" "https://cdn.wasmer.io/webcimages/$webc_sha.webc" "$webc_sha" "$name.webc")"
  local module="$package/modules/$name"
  if [[ "$(sha256 "$module")" != "$module_sha" ]]; then
    echo "error: the published package's \`$name\` module is not the one expected" >&2
    exit 1
  fi

  local entry offset old new
  for entry in "$@"; do
    read -r offset old new <<<"$entry"
    if [[ "$(bytes_at "$module" "$offset" $((${#old} / 2)))" != "$old" ]]; then
      echo "error: the module does not hold $old at $offset" >&2
      exit 1
    fi
    put_bytes "$module" "$offset" "$new"
  done
  local built
  built="$(sha256 "$module")"
  if [[ "$built" != "$patched_sha" ]]; then
    echo "error: the patched module hashed to $built, expected $patched_sha" >&2
    exit 1
  fi

  find "$package" -exec env TZ=UTC0 touch -h -t "$built_on" {} +
  local out
  out="$(out_dir package "$name" "$version")"
  "$wasmer/bin/wasmer" package build --quiet -o "$out/$name.webc" "$package"

  echo "built $out/$name.webc"
  echo "  module  $built"
  echo "  package $(sha256 "$out/$name.webc")"
}
