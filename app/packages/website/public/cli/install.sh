#!/bin/sh
# Installs the standalone Infrawrench CLI (`infrawrench`), a single executable
# with nothing else to install, from the latest Infrawrench release:
#
#   curl -fsSL https://infrawrench.com/cli/install.sh | sh
#
# Settings, all optional:
#   INFRAWRENCH_VERSION      a release to install (e.g. 2.4.0) instead of the latest
#   INFRAWRENCH_INSTALL_DIR  where to put it (default /usr/local/bin when writable,
#                            else ~/.local/bin)
#   INFRAWRENCH_DOWNLOAD_BASE  a release directory to download from instead of
#                            GitHub (a mirror, or the tests)
#
# Debian and Ubuntu can install it from the APT repository instead, which
# keeps it updated: https://infrawrench.com/docs/features/cli
#
# The source is app/packages/website/public/cli/install.sh in
# https://github.com/Infrawrench/Infrawrench.
set -eu

REPO="https://github.com/Infrawrench/Infrawrench"
SUMS="infrawrench-cli-SHA256SUMS"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'infrawrench install: %s\n' "$*" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "needs curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "needs sha256sum or shasum to check the download"
  fi
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no executable for $(uname -s). Install with npm instead: npm install -g @infrawrench/cli" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no executable for $(uname -m). Install with npm instead: npm install -g @infrawrench/cli" ;;
esac

# A shell under Rosetta reports x86_64 on Apple silicon: take the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

# The executable is Node's official build, which needs glibc.
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "no executable for musl (Alpine). Install with npm instead: npm install -g @infrawrench/cli"
fi

if [ -n "${INFRAWRENCH_DOWNLOAD_BASE:-}" ]; then
  base="$INFRAWRENCH_DOWNLOAD_BASE"
elif [ -n "${INFRAWRENCH_VERSION:-}" ]; then
  base="$REPO/releases/download/v${INFRAWRENCH_VERSION#v}"
else
  base="$REPO/releases/latest/download"
fi

if [ -n "${INFRAWRENCH_INSTALL_DIR:-}" ]; then
  dir="$INFRAWRENCH_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  dir=/usr/local/bin
else
  dir="$HOME/.local/bin"
fi
target="$dir/infrawrench"

# The desktop app's shell command lives at the same path. Replacing it would
# quietly swap that CLI (local accounts included) for this one.
if [ -f "$target" ] && grep -q "Launches the desktop app" "$target" 2>/dev/null; then
  fail "$target is the desktop app's shell command. The desktop app already gives you the CLI; to install this one anyway, set INFRAWRENCH_INSTALL_DIR to another directory."
fi

asset="infrawrench-cli-$os-$arch.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset..."
download "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset"
download "$base/$SUMS" "$tmp/$SUMS" || fail "could not download $base/$SUMS"

expected=""
while read -r hash name; do
  # `sha256sum` marks binary mode with a `*` before the name.
  if [ "${name#\*}" = "$asset" ]; then expected="$hash"; fi
done <"$tmp/$SUMS"
[ -n "$expected" ] || fail "$SUMS has no entry for $asset"
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

tar -xzf "$tmp/$asset" -C "$tmp" infrawrench
mkdir -p "$dir"
# Into place with one rename, so a running `infrawrench` is never half-written.
cp "$tmp/infrawrench" "$dir/.infrawrench.new"
chmod 755 "$dir/.infrawrench.new"
mv -f "$dir/.infrawrench.new" "$target"

say "Installed infrawrench $("$target" --version 2>/dev/null || true) to $target"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "$dir is not on your PATH. Add it, for example: export PATH=\"$dir:\$PATH\"" ;;
esac
say "Next: infrawrench login"
