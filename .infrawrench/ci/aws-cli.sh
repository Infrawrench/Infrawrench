#!/usr/bin/env bash
#
# AWS CLI v2 for a `platform: linux` machine, which does not ship it
# (ci-runner/images/linux/packages.txt), into a directory the job caches:
#
#   aws-cli.sh <dir>   then: export PATH="<dir>/bin:$PATH"
#
# The release's zip, pinned and checked against the SHA-256 it had when it
# was pinned (fetched from awscli.amazonaws.com over HTTPS). Skipped when the
# directory already has that version, which is what a restored cache looks
# like. Nothing is installed system-wide.
set -euo pipefail

AWS_CLI_VERSION=2.42.4
AWS_CLI_SHA256_X86_64=8998885d7fc32370c50efc2e44746c34b222a03d70015113a5554f98be79165c

dir="${1:?usage: aws-cli.sh <dir>}"

if "$dir/bin/aws" --version 2>/dev/null | grep -q "^aws-cli/$AWS_CLI_VERSION "; then
  exit 0
fi

case "$(uname -m)" in
  x86_64) sum="$AWS_CLI_SHA256_X86_64" ;;
  *)
    echo "error: aws-cli.sh pins only the x86_64 build, not $(uname -m)" >&2
    exit 1
    ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL --proto '=https' -o "$work/awscli.zip" \
  "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-$AWS_CLI_VERSION.zip"
echo "$sum  $work/awscli.zip" | sha256sum -c --quiet
unzip -q "$work/awscli.zip" -d "$work"
rm -rf "$dir/aws-cli"
mkdir -p "$dir/bin"
"$work/aws/install" --install-dir "$dir/aws-cli" --bin-dir "$dir/bin" --update >/dev/null
"$dir/bin/aws" --version
