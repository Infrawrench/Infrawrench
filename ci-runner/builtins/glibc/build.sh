#!/usr/bin/env bash
# builtin:glibc: Ubuntu 24.04's C library and C++ runtime, as a native tool
# of files alone (`abi: native-gvisor`, no program and no commands; README
# "Native binaries from npm"). Listing it in `tools:` runs the job in the
# native sandbox, where a Linux program the job has (turbo's and sherif's
# binaries, from `deps: [{ pnpm: { native: true } }]`, or one it built)
# runs natively, on this C library, when a WASIX process starts it. The
# runner's own binary runs inside the sandbox on the same files.
#
# The files and their paths are exactly builtin:bun's and builtin:rust's
# (`/lib/<arch>-linux-gnu/<name>` and the loader), so a job that names
# several mounts them once. Every input is pinned by SHA-256 against the
# `Packages` index that Ubuntu's signed `InRelease` names (the release
# pocket, whose files stay in the archive for good), the same packages
# bun/build.sh pins.
#
# Needs: curl, sha256sum, ar, tar with zstd.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

GLIBC_VERSION=2.39.0
out="$(out_dir builtin glibc "$GLIBC_VERSION")"

# target  archive path (noble, main)  sha256
DEBS=(
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8_amd64.deb af36c7ac770770fe3d3c10e85d6bc538e76e57570ba7db7d397fb9f654783ef3"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libstdc++6_14-20240412-0ubuntu1_amd64.deb 4863e880d6ee538e4734c430c5579c1ac933b88a42c25bc9980d0f148c54b21e"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libgcc-s1_14-20240412-0ubuntu1_amd64.deb a39efdcaa2245f026dc3254ce14fcff255fc430a17064632b6ba7c5da974a912"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6_2.39-0ubuntu8_arm64.deb 04d7cb73e608b41713b63ef915577f7f5d75e95b1b33174e82e05687fdb6cfaf"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libstdc++6_14-20240412-0ubuntu1_arm64.deb cd9ad360c8eee25e1fd9869303f4782eeaa47723594e85631c3def7ec42c3b08"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libgcc-s1_14-20240412-0ubuntu1_arm64.deb bb1c262f2ac9aeb357d3344a06f22f1057306694f6200896775a03ecced08b13"
)

# fetch <url> <sha256> <file>: downloads and checks one input.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet
}

targets=()
for target in x86_64 aarch64; do
  root="$SCRATCH/root-$target"
  mkdir -p "$root"
  for entry in "${DEBS[@]}"; do
    read -r arch url sha <<<"$entry"
    [[ "$arch" == "$target" ]] || continue
    file="$SCRATCH/$(basename "$url")"
    fetch "$url" "$sha" "$file"
    (cd "$SCRATCH" && ar x "$file" data.tar.zst && tar --zstd -xf data.tar.zst -C "$root" && rm data.tar.zst "$file")
  done
  libdir="$root/usr/lib/$target-linux-gnu"
  case "$target" in
    x86_64) loader_name=ld-linux-x86-64.so.2 loader_path=/lib64/ld-linux-x86-64.so.2 ;;
    aarch64) loader_name=ld-linux-aarch64.so.1 loader_path=/lib/ld-linux-aarch64.so.1 ;;
  esac
  # Each file as itself, not a symlink: the sandbox mounts files. A file
  # is stored once, under its SHA-256.
  add() {
    local real digest
    real="$(readlink -f "$2")"
    if [[ "$real" != "$root"/* ]]; then
      echo "glibc/build.sh: $2 points outside the packages ($real)" >&2
      exit 1
    fi
    digest="$(sha256sum "$real" | cut -d' ' -f1)"
    [[ -e "$out/$digest" ]] || install -m 0644 "$real" "$out/$digest"
    entries+=("{\"path\":\"$1\",\"file\":\"$digest\"}")
  }
  entries=()
  add "$loader_path" "$libdir/$loader_name"
  for lib in "$libdir"/*.so*; do
    add "/lib/$target-linux-gnu/$(basename "$lib")" "$lib"
  done
  targets+=("\"$target-linux\":{\"files\":[$(IFS=,; echo "${entries[*]}")]}")
done

cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "glibc",
  "version": "$GLIBC_VERSION",
  "abi": "native-gvisor",
  "targets": {$(IFS=,; echo "${targets[*]}")},
  "description": "Ubuntu 24.04's C library (glibc 2.39) and C++ runtime: puts a job in the native sandbox, where the Linux programs it has run natively"
}
JSON
echo "built $out"
