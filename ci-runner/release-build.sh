#!/usr/bin/env bash
# Builds the `iwci` a release publishes, the way the release builds it:
# `cargo build --release -p iwci --features node`, on Ubuntu 22.04, with the
# bridge's C++ compiled by GCC 12. ci-runner-release.yml runs this to
# publish, and ci-runner-release-build.yml runs it on pull requests that
# touch the bridge, its V8 or the release workflow, so a header or toolchain
# mismatch fails there and not in a release.
#
# Why Ubuntu 22.04: the binary is installed over SSH on hosts we do not
# choose the distribution of, so it asks for no more than 22.04 has, which
# is glibc 2.35 and GCC 12's libstdc++ (GLIBCXX_3.4.30). The check at the end
# holds it to that.
#
# Why GCC 12: 22.04's default compiler is GCC 11, whose libstdc++ headers
# predate what V8 15.9's headers use (a constexpr `unique_ptr::get`, C++23).
# GCC 12 is 22.04's own package, its headers are the ones the V8 archive was
# compiled against (builtins/v8/build.sh), and its runtime is the
# libstdc++.so.6 22.04 already ships, so the binary needs nothing newer.
#
#   ./release-build.sh     -> target/release/iwci
#
# CXX names another compiler (the check still applies). Needs the V8 archive
# where the bridge's build.rs looks (builtins/v8/archive.sh fetch).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

MAX_GLIBC="2.35"
MAX_GLIBCXX="3.4.30"

if [[ -z "${CXX:-}" ]]; then
  if ! command -v g++-12 >/dev/null; then
    sudo apt-get update -q
    sudo apt-get install -y -q --no-install-recommends g++-12
  fi
  export CXX=g++-12
fi
echo "release-build.sh: C++ compiler: $("$CXX" --version | head -n 1)"

cargo build --release -p iwci --features node
binary="target/release/iwci"

# highest <binary> <prefix>: the newest version of that symbol set the
# binary asks its shared libraries for, such as 2.34 for GLIBC.
highest() {
  objdump -T "$1" | grep -oE "\b$2_[0-9]+(\.[0-9]+)*" | sed "s/^$2_//" | sort -uV | tail -n 1
}

# at_most <version> <limit>
at_most() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" == "$2" ]]
}

glibc="$(highest "$binary" GLIBC)"
glibcxx="$(highest "$binary" GLIBCXX)"
echo "release-build.sh: $binary needs GLIBC_${glibc:-none} and GLIBCXX_${glibcxx:-none}"
if [[ -z "$glibc" || -z "$glibcxx" ]]; then
  echo "release-build.sh: could not read the binary's symbol versions" >&2
  exit 1
fi
if ! at_most "$glibc" "$MAX_GLIBC" || ! at_most "$glibcxx" "$MAX_GLIBCXX"; then
  echo "release-build.sh: that is more than Ubuntu 22.04 has (GLIBC_$MAX_GLIBC, GLIBCXX_$MAX_GLIBCXX)" >&2
  exit 1
fi
