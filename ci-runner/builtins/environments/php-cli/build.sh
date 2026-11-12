#!/usr/bin/env bash
# `iwci/php-cli`, the package `env:php` adds to Wasmer's phpix: a `php`
# that keeps the caller's working directory and answers -m and -l
# (fs/bin/php), and Composer (fs/bin/composer, with the phar pinned below).
# Its files are mounted at /opt/php-cli, and the environment puts
# /opt/php-cli/bin on PATH ahead of phpix's own `php`.
#
# A webc records each file's modification time, so every file gets the same
# one and the package comes out byte for byte the same wherever it is built;
# environments/build.sh pins its hash like any other package's.
#
#   environments/php-cli/build.sh    -> dist/package/php-cli/<version>/php-cli.webc
#
# Needs: curl, sha256sum, tar; Linux on x86_64 or ARM64 (for the Wasmer CLI).
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"

# The package's own version: a change to anything here is a new one.
VERSION="1.0.0"
BUILT_ON="1767225600" # 2026-01-01T00:00:00Z

COMPOSER_VERSION="2.11.2"
COMPOSER_URL="https://getcomposer.org/download/$COMPOSER_VERSION/composer.phar"
# getcomposer.org/download/2.11.2/composer.phar.sha256sum
COMPOSER_SHA256="dd158c0afd41d15fac89e1b4e47b5d42911fe316c3687cd5edac98319b25d028"

# The Wasmer CLI, only to build the package (the same release as Edge.js's).
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
    echo "error: php-cli builds on Linux, x86_64 or ARM64 (for the Wasmer CLI)" >&2
    exit 1
    ;;
esac

src="$here/environments/php-cli"
work="$SCRATCH/php-cli"
mkdir -p "$work/dl" "$work/wasmer"

# download <url> <sha256> <file>
download() {
  local url="$1" sha="$2" file="$work/dl/$3"
  curl -fsSL --retry 3 -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    exit 1
  fi
  printf '%s\n' "$file"
}

tar -xzf "$(download "$WASMER_URL" "$WASMER_SHA256" wasmer.tar.gz)" -C "$work/wasmer"

package="$work/package"
mkdir -p "$package"
cp -R "$src/fs" "$package/fs"
cp "$(download "$COMPOSER_URL" "$COMPOSER_SHA256" composer.phar)" "$package/fs/lib/composer.phar"
cat >"$package/wasmer.toml" <<TOML
[package]
name = "iwci/php-cli"
version = "$VERSION"
description = "php-cli behaviour for phpix, and Composer $COMPOSER_VERSION"

[fs]
"/opt/php-cli" = "fs"
TOML
chmod 0755 "$package/fs/bin/"*
chmod 0644 "$package/fs/lib/"*
find "$package" -exec touch -h -d "@$BUILT_ON" {} +

out="$(out_dir package php-cli "$VERSION")"
WASMER_DIR="$work/wasmer-home" "$work/wasmer/bin/wasmer" package build --quiet -o "$out/php-cli.webc" "$package"
echo "built $out/php-cli.webc"
echo "  package $(sha256sum "$out/php-cli.webc" | cut -d' ' -f1)"
