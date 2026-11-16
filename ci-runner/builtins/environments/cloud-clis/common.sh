# shellcheck shell=bash
# Shared by cloud-clis/build.sh and lock.sh: the interpreter the tools run
# on and the Wasmer CLI that unpacks it, each pinned once elsewhere and read
# from there.
#
#   PYTHON_WEBC   Wasmer's python/python package, which env:python's is
#                 built from (python/build.sh)
#   WASMER        the Wasmer CLI php-cli/build.sh pins, unpacked
#   PYTHON_TREE   the package unpacked: modules/python and fs/
#   PYTHON_PREFIX the interpreter's prefix inside fs/ (the Nix store path)
#
# Linux, x86_64 or ARM64 (the Wasmer CLI). Needs curl, sha256sum, tar.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"

# python/python's line in environments/build.sh: name, version. Its hash
# is our build's; pip runs on Wasmer's package it is built from, whose
# hash python/build.sh pins: the Wasmer CLI that runs it has none of the
# runner's own calls, which ours imports (#1216). It is the same
# interpreter otherwise.
read -r _ PYTHON_PKG_VERSION _ <<<"$(sed -n 's/^PYTHON_PKG="\(.*\)"$/\1/p' "$here/environments/build.sh")"
PYTHON_PKG_SHA="$(sed -n 's/^WEBC_SHA256="\(.*\)"$/\1/p' "$here/environments/python/build.sh")"
PYTHON_PREFIX_GUEST="$(sed -n 's/^PYTHON_PREFIX="\(.*\)"$/\1/p' "$here/environments/build.sh")"
if [[ -z "${PYTHON_PKG_SHA:-}" || -z "$PYTHON_PREFIX_GUEST" ]]; then
  echo "error: environments/build.sh or python/build.sh pins no PYTHON_PKG, PYTHON_PREFIX or WEBC_SHA256; cloud-clis reads them" >&2
  exit 1
fi
# The Wasmer CLI, as php-cli/build.sh pins it for this host (its `case`
# block, read literally).
# shellcheck disable=SC2016
eval "$(sed -n '/^case "$(uname -s)-$(uname -m)" in$/,/^esac$/p' "$here/environments/php-cli/build.sh" |
  sed 's/echo "error: php-cli builds/echo "error: cloud-clis build/')"

tools_work="$SCRATCH/cloud-clis"
mkdir -p "$tools_work/dl"

# fetch <url> <sha256> <file>: downloaded once, checked every time.
fetch() {
  local url="$1" sha="$2" file="$tools_work/dl/$3"
  [[ -f "$file" ]] || curl -fsSL --retry 3 -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    exit 1
  fi
  printf '%s\n' "$file"
}

mkdir -p "$tools_work/wasmer"
tar -xzf "$(fetch "$WASMER_URL" "$WASMER_SHA256" wasmer.tar.gz)" -C "$tools_work/wasmer"
WASMER="$tools_work/wasmer/bin/wasmer"
export WASMER_DIR="$tools_work/wasmer-home"
PYTHON_WEBC="$(fetch "https://cdn.wasmer.io/webcimages/$PYTHON_PKG_SHA.webc" "$PYTHON_PKG_SHA" python.webc)"
PYTHON_TREE="$tools_work/python"
rm -rf "$PYTHON_TREE"
"$WASMER" package unpack "$PYTHON_WEBC" --out-dir "$PYTHON_TREE" >/dev/null
PYTHON_PREFIX="$PYTHON_TREE/fs$PYTHON_PREFIX_GUEST"
[[ -d "$PYTHON_PREFIX/lib/python3.13" ]] || {
  echo "error: python/python $PYTHON_PKG_VERSION has no $PYTHON_PREFIX_GUEST/lib/python3.13" >&2
  exit 1
}

# python <args...>: env:python's own interpreter, through the Wasmer CLI,
# with the network and the tool's work directory at /work, and the
# environment's pip defaults (README.md, "Python").
wasix_python() {
  "$WASMER" run --net --volume "$tools_work:/work" \
    --env _PYTHON_HOST_PLATFORM=wasix-wasm32 \
    --env PIP_EXTRA_INDEX_URL=https://python-registry.wasix.org/simple/ \
    --env PIP_PREFER_BINARY=1 --env PIP_DISABLE_PIP_VERSION_CHECK=1 \
    --env PIP_ROOT_USER_ACTION=ignore \
    "$PYTHON_WEBC" -- "$@"
}
