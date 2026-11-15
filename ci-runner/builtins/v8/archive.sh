#!/usr/bin/env bash
# The V8 build the bridge links (build.sh), kept in the runner pool's bucket
# under v8-prebuilt/<version>/<arch>/ and checked against the SHA-256 pinned
# in vendor/wasmer-napi/build.rs both ways.
#
#   builtins/v8/archive.sh fetch [amd64|arm64]   download into dist/v8/, where
#                                                the bridge's build.rs looks
#                                                (default: this machine's)
#   builtins/v8/archive.sh store amd64|arm64     upload what build.sh left
#
# R2 through the AWS CLI, with publish.sh's IWCI_R2_ACCOUNT_ID,
# IWCI_R2_BUCKET, IWCI_R2_ACCESS_KEY_ID and IWCI_R2_SECRET_ACCESS_KEY. An
# archive already stored is never replaced: a changed build is a new
# version in build.rs.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

build_rs="$here/../vendor/wasmer-napi/build.rs"
version="$(sed -n 's/^const PREBUILT_V8_VERSION: &str = "\(.*\)";$/\1/p' "$build_rs")"
if [[ -z "$version" ]]; then
  echo "archive.sh: found no PREBUILT_V8_VERSION in $build_rs" >&2
  exit 1
fi

command="${1:-}"
arch="${2:-}"
if [[ -z "$arch" && "$command" == fetch ]]; then
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
  esac
fi
case "$command:$arch" in
  fetch:amd64 | fetch:arm64 | store:amd64 | store:arm64) ;;
  *)
    echo "usage: builtins/v8/archive.sh fetch|store amd64|arm64" >&2
    exit 2
    ;;
esac

pin="$(sed -n "s/^        \"linux-$arch\" => Ok(\"\([0-9a-f]\{64\}\)\"),\$/\1/p" "$build_rs")"
if [[ -z "$pin" ]]; then
  echo "archive.sh: found no pinned SHA-256 for linux-$arch in $build_rs" >&2
  exit 1
fi
name="v8-linux-$arch.tar.xz"
file="$dist/v8/$version/$name"
key="v8-prebuilt/$version/$arch/$name"

for var in IWCI_R2_ACCOUNT_ID IWCI_R2_BUCKET IWCI_R2_ACCESS_KEY_ID IWCI_R2_SECRET_ACCESS_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "archive.sh: $var is not set; the V8 build is in the runner pool's bucket" >&2
    exit 1
  fi
done

r2() {
  env -u AWS_PROFILE \
    AWS_ACCESS_KEY_ID="$IWCI_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$IWCI_R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws --endpoint-url "https://$IWCI_R2_ACCOUNT_ID.r2.cloudflarestorage.com" "$@"
}

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# check <file>: fails unless it hashes to the pin.
check() {
  local actual
  actual="$(sha256_of "$1")"
  if [[ "$actual" != "$pin" ]]; then
    echo "archive.sh: $1 hashes to $actual, not the pinned $pin" >&2
    return 1
  fi
}

case "$command" in
  fetch)
    if [[ -f "$file" ]] && check "$file" 2>/dev/null; then
      echo "archive.sh: $name $version is already here"
      exit 0
    fi
    mkdir -p "$(dirname -- "$file")"
    r2 s3 cp --only-show-errors "s3://$IWCI_R2_BUCKET/$key" "$SCRATCH/$name"
    check "$SCRATCH/$name"
    mv "$SCRATCH/$name" "$file"
    echo "archive.sh: fetched $key ($pin)"
    ;;
  store)
    check "$file"
    if r2 s3 cp --only-show-errors "s3://$IWCI_R2_BUCKET/$key" "$SCRATCH/stored" 2>/dev/null; then
      if [[ "$(sha256_of "$SCRATCH/stored")" == "$pin" ]]; then
        echo "archive.sh: $key is already stored"
        exit 0
      fi
      echo "archive.sh: $key is stored with other bytes; a new build is a new version" >&2
      exit 1
    fi
    r2 s3 cp --only-show-errors "$file" "s3://$IWCI_R2_BUCKET/$key"
    echo "archive.sh: stored $key ($pin)"
    ;;
esac
