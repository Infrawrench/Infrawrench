#!/usr/bin/env bash
# builtin:bun: the official Bun release, run natively in a gVisor sandbox
# beside the job's environment (`abi: native-gvisor`; README "Native tools
# in a sandbox"). Nothing is compiled: the release's own `bun` for each
# target, and the C library it links, which the sandbox has none of. The
# runner's own binary runs in the same sandbox, so the C++ runtime it links
# (libstdc++, libgcc_s) comes along too.
#
# Every input is pinned by SHA-256: Bun's zips against its release's
# SHASUMS256.txt, and Ubuntu 24.04's packages (the release pocket, whose
# files stay in the archive for good) against the `Packages` index its
# signed `InRelease` names. A changed download fails the build.
#
# Needs: curl, sha256sum, python3, ar, tar with zstd.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

BUN_VERSION=1.4.4
# The builtin's version is Bun's, and a fourth number counts our rebuilds
# of one Bun release (a published version never changes; `@1.4.4` picks
# the highest rebuild). 1: the rest of the C library (librt and others).
# Back to none (BUN_REBUILD=0) with the next Bun release.
BUN_REBUILD=1
version="$BUN_VERSION"
[[ "$BUN_REBUILD" == 0 ]] || version="$BUN_VERSION.$BUN_REBUILD"
out="$(out_dir builtin bun "$version")"

# target  bun asset                bun sha256
BUN_ASSETS=(
  "x86_64 bun-linux-x64 bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"
  "aarch64 bun-linux-aarch64 baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"
)

# target  archive path (noble, main)                              sha256
DEBS=(
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8_amd64.deb af36c7ac770770fe3d3c10e85d6bc538e76e57570ba7db7d397fb9f654783ef3"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libstdc++6_14-20240412-0ubuntu1_amd64.deb 4863e880d6ee538e4734c430c5579c1ac933b88a42c25bc9980d0f148c54b21e"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libgcc-s1_14-20240412-0ubuntu1_amd64.deb a39efdcaa2245f026dc3254ce14fcff255fc430a17064632b6ba7c5da974a912"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6_2.39-0ubuntu8_arm64.deb 04d7cb73e608b41713b63ef915577f7f5d75e95b1b33174e82e05687fdb6cfaf"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libstdc++6_14-20240412-0ubuntu1_arm64.deb cd9ad360c8eee25e1fd9869303f4782eeaa47723594e85631c3def7ec42c3b08"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libgcc-s1_14-20240412-0ubuntu1_arm64.deb bb1c262f2ac9aeb357d3344a06f22f1057306694f6200896775a03ecced08b13"
)

# The libraries Bun and the runner link, by the name the loader asks for,
# and the rest of the C library a native program or addon Bun loads may
# link: rolldown's and oxlint's Node bindings need librt, which glibc 2.34
# folded into libc but still ships as its own file.
LIBS=(libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 libstdc++.so.6 libgcc_s.so.1
  librt.so.1 libutil.so.1 libresolv.so.2 libanl.so.1 libmvec.so.1)

# fetch <url> <sha256> <file>: downloads and checks one input.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet
}

files_json=()
for entry in "${BUN_ASSETS[@]}"; do
  read -r arch asset sha <<<"$entry"
  zip="$SCRATCH/$asset.zip"
  fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$asset.zip" "$sha" "$zip"
  mkdir -p "$SCRATCH/$asset"
  python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$SCRATCH/$asset"
  install -m 0755 "$SCRATCH/$asset/$asset/bun" "$out/bun-$arch"

  root="$SCRATCH/root-$arch"
  mkdir -p "$root"
  for deb in "${DEBS[@]}"; do
    read -r deb_arch url deb_sha <<<"$deb"
    [[ "$deb_arch" == "$arch" ]] || continue
    file="$SCRATCH/$(basename "$url")"
    fetch "$url" "$deb_sha" "$file"
    (cd "$SCRATCH" && ar x "$file" data.tar.zst && tar --zstd -xf data.tar.zst -C "$root" && rm data.tar.zst)
  done
  libdir="$root/usr/lib/$arch-linux-gnu"
  case "$arch" in
    x86_64) loader_name=ld-linux-x86-64.so.2 loader_path=/lib64/ld-linux-x86-64.so.2 ;;
    aarch64) loader_name=ld-linux-aarch64.so.1 loader_path=/lib/ld-linux-aarch64.so.1 ;;
  esac
  # Each file as itself, not a symlink: the sandbox mounts files.
  install -m 0755 "$(readlink -f "$libdir/$loader_name")" "$out/$arch-$loader_name"
  entries="{\"path\":\"$loader_path\",\"file\":\"$arch-$loader_name\"}"
  for lib in "${LIBS[@]}"; do
    install -m 0644 "$(readlink -f "$libdir/$lib")" "$out/$arch-$lib"
    entries+=",{\"path\":\"/lib/$arch-linux-gnu/$lib\",\"file\":\"$arch-$lib\"}"
  done
  files_json+=("\"$arch-linux\":{\"program\":\"bun-$arch\",\"files\":[$entries]}")
done

targets="$(IFS=,; echo "${files_json[*]}")"
cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "bun",
  "version": "$version",
  "abi": "native-gvisor",
  "aliases": ["bunx"],
  "targets": {$targets},
  "description": "Bun $BUN_VERSION, the official release, run natively in a gVisor sandbox beside the job's environment"
}
JSON
echo "built $out"
