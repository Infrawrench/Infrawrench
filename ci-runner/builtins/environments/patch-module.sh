# shellcheck shell=bash
# Shared by bash/build.sh and sed/build.sh, which each change a few bytes of
# the module in one of Wasmer's published packages and package it again,
# and python/build.sh, which changes its module another way.
# Sourced after builtins/lib.sh; defines `patch_package` and
# `rewrite_package` and runs nothing.
#
# The module goes back into the package with the Wasmer CLI, as
# `edgejs/build.sh` does it, which records each file's hash for the
# runtime's module cache, so a webc is never edited in place. Linux (x86_64
# or arm64) or macOS on arm64: the Wasmer CLI's release archives. The result
# is the same bytes on each, which `environments/build.sh` pins, as long as
# the package is unpacked on a case-sensitive file system
# (`case_sensitive_dir`, which on macOS mounts one for the run).
#
# Needs: bash, curl, tar, sha256sum or shasum, od, dd; on macOS, hdiutil.

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
  rewrite_package "$work" "$name" "$version" "$webc_sha" "$module_sha" "$patched_sha" "$built_on" \
    apply_patches "$@"
}

# apply_patches <module> <patch>...: patch_package's byte patches.
apply_patches() {
  local module="$1" entry offset old new
  shift
  for entry in "$@"; do
    read -r offset old new <<<"$entry"
    if [[ "$(bytes_at "$module" "$offset" $((${#old} / 2)))" != "$old" ]]; then
      echo "error: the module does not hold $old at $offset" >&2
      exit 1
    fi
    put_bytes "$module" "$offset" "$new"
  done
}

# rewrite_package <work> <name> <version> <webc sha256> <module sha256>
#   <rewritten module sha256> <built on> <command>...
#
# patch_package with any change: runs <command> with the module's path
# put after its first word (`<command> <module> <arguments>...`), which
# changes the module in place, and goes on as patch_package does. The
# package is `<owner>/<name>`'s from the CDN; its module is
# `modules/<name>`.
rewrite_package() {
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

  case_sensitive_dir "$work"
  local package="$CASE_SENSITIVE_DIR/package"
  rm -rf "$package"
  "$wasmer/bin/wasmer" package unpack --quiet -o "$package" \
    "$(download "$work/dl" "https://cdn.wasmer.io/webcimages/$webc_sha.webc" "$webc_sha" "$name.webc")"
  local module="$package/modules/$name"
  if [[ "$(sha256 "$module")" != "$module_sha" ]]; then
    echo "error: the published package's \`$name\` module is not the one expected" >&2
    exit 1
  fi

  local command="$1"
  shift
  "$command" "$module" "$@"
  local built
  built="$(sha256 "$module")"
  if [[ "$built" != "$patched_sha" ]]; then
    echo "error: the changed module hashed to $built, expected $patched_sha" >&2
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

# case_sensitive_dir <work>: sets CASE_SENSITIVE_DIR to <work>, or a directory
# under it, where names that differ only in case are different files.
#
# Wasmer's packages have such names (python/python's terminfo has `a/` and
# `A/`, `2621a` and `2621A`: 66 paths), and a case-insensitive file system
# (macOS's default, or a macOS directory mounted into a Linux container)
# folds each pair into one while the package is unpacked. The package then
# packs with fewer files and other bytes, and nothing fails until the hash
# check (#1335). On macOS this attaches a case-sensitive APFS disk image
# under <work> for the rest of the run; anywhere else a case-insensitive
# <work> is an error.
case_sensitive_dir() {
  local work="$1"
  if is_case_sensitive "$work"; then
    CASE_SENSITIVE_DIR="$work"
    return
  fi
  if [[ "$(uname -s)" != Darwin ]]; then
    echo "error: $work is on a case-insensitive file system, which would drop files from the package; build somewhere case-sensitive (not a macOS directory mounted into a container)" >&2
    exit 1
  fi
  local image="$work/case-sensitive.sparseimage" mount="$work/case-sensitive"
  # A run that was killed can leave the last one attached.
  hdiutil detach -quiet -force "$mount" 2>/dev/null || true
  rm -rf "$image" "$mount"
  mkdir -p "$mount"
  # Sparse: it takes only what the package does, up to the size given.
  hdiutil create -quiet -size 8g -type SPARSE -fs "Case-sensitive APFS" \
    -volname iwci-package "$image"
  hdiutil attach -quiet -nobrowse -noautoopen -mountpoint "$mount" "$image"
  CASE_SENSITIVE_MOUNT="$mount" CASE_SENSITIVE_IMAGE="$image"
  # Detached and removed at exit, then lib.sh's scratch directory (as
  # clickhouse/build.sh adds to that trap).
  trap 'hdiutil detach -quiet -force "$CASE_SENSITIVE_MOUNT" || true
    rm -rf "$CASE_SENSITIVE_MOUNT" "$CASE_SENSITIVE_IMAGE" "$SCRATCH"' EXIT
  if ! is_case_sensitive "$mount"; then
    echo "error: the disk image at $mount is not case-sensitive" >&2
    exit 1
  fi
  CASE_SENSITIVE_DIR="$mount"
}

# is_case_sensitive <dir>: whether <dir> tells `x` from `X`.
is_case_sensitive() {
  local lower="$1/.iwci-case-probe" upper="$1/.IWCI-CASE-PROBE" sensitive=0
  rm -f "$lower" "$upper"
  : >"$lower"
  [[ -e "$upper" ]] && sensitive=1
  rm -f "$lower" "$upper"
  ((sensitive == 0))
}
