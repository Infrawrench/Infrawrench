#!/usr/bin/env bash
# The packages env:aws, env:az and env:gcloud add to env:python: each cloud
# CLI installed into a directory of its own under /opt, with a command in
# its bin/ that runs it on the environment's CPython apart from whatever a
# job installs (`python3 -E -s -S`: no PYTHON* variables, no user or
# system site directory; its own added by hand).
#
#   cloud-clis/build.sh aws     iwci/aws-cli      AWS CLI 1, /opt/aws-cli
#   cloud-clis/build.sh az      iwci/azure-cli    Azure CLI, /opt/azure-cli,
#                               iwci/azure-cli-mgmt  and its management SDKs
#                                                 at /opt/azure-cli-mgmt
#   cloud-clis/build.sh gcloud  iwci/gcloud       Google Cloud CLI,
#                               iwci/gcloud-apis  /opt/google-cloud-sdk, and
#                                                 its API clients at
#                                                 /opt/gcloud-apis
#
#   -> dist/package/<package>/<version>/<package>.webc
#
# The AWS and Azure CLIs come from PyPI and Wasmer's WASIX index, installed
# from <tool>/requirements.lock (lock.sh) by env:python's own pip, so every
# file is checked against its hash and every compiled module is a WASIX
# wheel's. gcloud is Google's versioned archive, pinned by hash, less its
# bundled native Python, gsutil (gcloud storage does what it did) and the
# native helpers.
#
# A package file can be at most 256 MiB (the store's limit), which the
# Azure CLI (370 MB) and gcloud (350 MB) are not, so each is two packages:
# the Azure management SDKs are namespace packages, so a second site
# directory holds them; gcloud's generated API clients are one package's
# subpackages, so its `__init__.py` names the second directory in
# `__path__` (one line, below, checked to apply).
#
# No bytecode is shipped: it would double the size, and a job compiles
# what it imports into its own copy as it goes (gcloud --version in a
# fresh job: see README.md, "Cloud CLIs").
#
# Every file gets one modification time and the build is reproducible:
# environments/build.sh pins each package's hash like any other's.
#
# Linux, x86_64 or ARM64 (the Wasmer CLI runs env:python's pip). Needs
# curl, sha256sum, tar, and the internet (PyPI, Wasmer's index, Google).
set -euo pipefail
tool="${1:?usage: cloud-clis/build.sh aws|az|gcloud}"
# shellcheck source=builtins/environments/cloud-clis/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
self="$here/environments/cloud-clis"
BUILT_ON="1767225600" # 2026-01-01T00:00:00Z

# The gcloud release: Google's versioned archive for x86_64 Linux (the
# Python is the same on every architecture, and the native parts are
# dropped), checked once by hand against the "latest" archive's listing.
GCLOUD_VERSION="593.0.0"
GCLOUD_URL="https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-$GCLOUD_VERSION-linux-x86_64.tar.gz"
GCLOUD_SHA256="42c32b7553c712f71fcf6f124546c0519437f53755f47f9bd0c957998cd6b826"

# Each package's own version: the CLI's, then our revision. A change to
# anything here is a new revision.
AWS_PKG_VERSION="1.46.3-iwci.1"
AZ_PKG_VERSION="2.92.0-iwci.1"
GCLOUD_PKG_VERSION="$GCLOUD_VERSION-iwci.1"

# install <tool> <dir>: the tool's lock into <dir>, by env:python's pip.
install() {
  rm -rf "$tools_work/site"
  cp "$self/$1/requirements.lock" "$tools_work/requirements.lock"
  wasix_python -m pip install --quiet --no-deps --require-hashes --only-binary=:all: \
    --no-compile --target /work/site -r /work/requirements.lock
  # Console scripts with this machine's paths; the package has its own.
  rm -rf "$tools_work/site/bin"
  mkdir -p "$(dirname "$2")"
  mv "$tools_work/site" "$2"
}

# launcher <file> <script>: the command, on the environment's CPython apart
# from the job's own packages and PYTHON* variables. Not `-I`, which would
# also leave the script's directory off sys.path: gcloud's bq imports its
# bootstrapping module from there.
launcher() {
  mkdir -p "$(dirname "$1")"
  cat >"$1" <<SH
#!/bin/bash
exec /usr/bin/python3 -E -s -S $2 "\$@"
SH
  chmod 0755 "$1"
}

# package <name> <version> <mount> <tree> <description>: <tree> as a
# package whose files appear at <mount>.
package() {
  local name="$1" version="$2" mount="$3" tree="$4" description="$5"
  local dir="$tools_work/pkg-$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  mv "$tree" "$dir/fs"
  find "$dir/fs" -name __pycache__ -type d -prune -exec rm -rf {} +
  cat >"$dir/wasmer.toml" <<TOML
[package]
name = "iwci/$name"
version = "$version"
description = "$description"

[fs]
"$mount" = "fs"
TOML
  find "$dir" -exec touch -h -d "@$BUILT_ON" {} +
  local out
  out="$(out_dir package "$name" "$version")"
  "$WASMER" package build --quiet -o "$out/$name.webc" "$dir"
  local size
  size="$(stat -c %s "$out/$name.webc")"
  if ((size > 256 * 1024 * 1024)); then
    echo "error: iwci/$name is $size bytes, over the store's 256 MiB per file" >&2
    exit 1
  fi
  echo "built $out/$name.webc"
  echo "  package $(sha256sum "$out/$name.webc" | cut -d' ' -f1) ($size bytes)"
}

case "$tool" in
  aws)
    root="$tools_work/aws-cli"
    install aws "$root/site"
    mkdir -p "$root/lib"
    cat >"$root/lib/main.py" <<'PY'
import site
import sys

site.addsitedir("/opt/aws-cli/site")
sys.argv[0] = "aws"
from awscli.clidriver import main

sys.exit(main())
PY
    launcher "$root/bin/aws" /opt/aws-cli/lib/main.py
    package aws-cli "$AWS_PKG_VERSION" /opt/aws-cli "$root" "The AWS CLI ${AWS_PKG_VERSION%-iwci.*} for env:aws"
    ;;
  az)
    root="$tools_work/azure-cli"
    install az "$root/site"
    # The management SDKs (namespace packages under azure.mgmt) apart.
    mkdir -p "$tools_work/azure-cli-mgmt/site/azure"
    mv "$root/site/azure/mgmt" "$tools_work/azure-cli-mgmt/site/azure/mgmt"
    mkdir -p "$root/lib"
    cp "$self/az/main.py" "$root/lib/main.py"
    launcher "$root/bin/az" /opt/azure-cli/lib/main.py
    package azure-cli "$AZ_PKG_VERSION" /opt/azure-cli "$root" "The Azure CLI ${AZ_PKG_VERSION%-iwci.*} for env:az"
    package azure-cli-mgmt "$AZ_PKG_VERSION" /opt/azure-cli-mgmt "$tools_work/azure-cli-mgmt" \
      "The Azure CLI ${AZ_PKG_VERSION%-iwci.*}'s management SDKs for env:az"
    ;;
  gcloud)
    archive="$(fetch "$GCLOUD_URL" "$GCLOUD_SHA256" gcloud.tar.gz)"
    rm -rf "$tools_work/gcloud"
    mkdir -p "$tools_work/gcloud"
    tar -xzf "$archive" -C "$tools_work/gcloud"
    sdk="$tools_work/gcloud/google-cloud-sdk"
    [[ "$(cat "$sdk/VERSION")" == "$GCLOUD_VERSION" ]] || { echo "error: the archive is not gcloud $GCLOUD_VERSION" >&2; exit 1; }
    # Native code (the bundled Python, the CRC32C helper, crcmod's macOS
    # build), gsutil (gcloud storage replaces it), and installers.
    rm -rf "$sdk/platform/bundledpythonunix" "$sdk/platform/gsutil" "$sdk/platform/gcloud-crc32c_licenses" \
      "$sdk/bin/gcloud-crc32c" "$sdk/bin/gsutil" "$sdk/rpm" "$sdk/deb" "$sdk/install.sh" "$sdk/install.bat"
    if find "$sdk" -type f \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.exe' -o -name '*.dll' \) | grep -q .; then
      echo "error: native code left in gcloud:" >&2
      find "$sdk" -type f \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.exe' -o -name '*.dll' \) >&2
      exit 1
    fi
    # The API clients apart: their package's __path__ names the second
    # directory, so `googlecloudsdk.generated_clients.apis.<api>` imports
    # from there.
    apis="$sdk/lib/googlecloudsdk/generated_clients/apis"
    mkdir -p "$tools_work/gcloud-apis/apis"
    find "$apis" -mindepth 1 -maxdepth 1 ! -name __init__.py ! -name apis_map.py ! -name __pycache__ \
      -exec mv {} "$tools_work/gcloud-apis/apis/" \;
    if [[ -n "$(grep -v -e '^#' -e '^$' -e '^"""Package marker file."""$' "$apis/__init__.py" || true)" ]]; then
      echo "error: gcloud's generated_clients/apis/__init__.py has code now; check the __path__ line still fits" >&2
      exit 1
    fi
    printf '\n# Infrawrench CI (env:gcloud): the API clients are a package of their own.\n__path__.append("/opt/gcloud-apis/apis")\n' >>"$apis/__init__.py"
    launcher "$sdk/bin/gcloud" /opt/google-cloud-sdk/lib/gcloud.py
    launcher "$sdk/bin/bq" /opt/google-cloud-sdk/bin/bootstrapping/bq.py
    package gcloud "$GCLOUD_PKG_VERSION" /opt/google-cloud-sdk "$sdk" "Google Cloud CLI $GCLOUD_VERSION for env:gcloud"
    package gcloud-apis "$GCLOUD_PKG_VERSION" /opt/gcloud-apis "$tools_work/gcloud-apis" \
      "Google Cloud CLI $GCLOUD_VERSION's API clients for env:gcloud"
    ;;
  *)
    echo "error: no cloud CLI \`$tool\`; know aws, az and gcloud" >&2
    exit 2
    ;;
esac
