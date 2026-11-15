#!/usr/bin/env bash
# The V8 the runner's Node bridge links (vendor/wasmer-napi, `--features
# node`), built from source as wasmerio/v8-custom-builds builds its
# releases: the same V8, the same patches and the same GN args, from that
# repository's commit for its 15.9.111.1 release. Three things differ. Two
# so that the archive links into the bridge, which the system's GCC compiles
# against libstdc++ and the system's GNU ld links, on the Ubuntu 22.04 the
# release builds on:
#
#   - No CREL. Chromium's clang writes compact relocations, which GNU ld
#     (2.38 on 22.04, 2.42 on 24.04) cannot read; no-crel.patch drops the
#     flag.
#   - Both architectures compile against a sysroot of Ubuntu 22.04's C
#     library and GCC 12's libstdc++ (packages pinned below): upstream builds
#     x86_64 on 22.04's own headers, and ARM64 against Chromium's libc++,
#     whose `std::__Cr` types the bridge cannot share. Newer headers would
#     tie the archive to a newer glibc (its C23 `__isoc23_*` functions) than
#     the release's hosts have. ARM64 is cross-compiled.
#
# And one for the jobs: every isolate gets a pointer-compression cage of its
# own (`v8_enable_pointer_compression_shared_cage=false`, so
# `IsolateGroup::CanCreateNewGroups()` is true and the bridge makes a group
# per isolate), where the release puts every isolate of the process in one
# 4 GiB cage that the heaps of all jobs share.
#
# The result is stored in the runner pool's bucket and fetched from there
# by archive.sh, both ways checked against the SHA-256 pinned in the
# bridge's build.rs. Building takes an hour or two and about 40 GB; it is
# not part of CI.
#
#   builtins/v8/build.sh amd64|arm64
#     -> dist/v8/<version>/v8-linux-<arch>.tar.xz, the version the
#        bridge's build.rs names (PREBUILT_V8_VERSION)
#
# V8_WORK keeps the checkout between runs (default: a scratch directory).
# NINJA_JOBS caps the build's parallelism.
#
# Needs: git, python3, curl, xz and dpkg-deb, on x86_64 Linux.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

V8_VERSION="15.9.111"
V8_COMMIT="eb69ea48cb9e5b5aeb4b3ded74e6b295badb16a7"
DEPOT_TOOLS_COMMIT="7a339079d178fbc9c6f6230082843d6e00b2551f"
# wasmerio/v8-custom-builds, tag 15.9.111.1: its patches and GN args.
CUSTOM_BUILDS_COMMIT="e20fafb7105ed8fdb67f40e4b039c87547e944fe"

# Ubuntu 22.04's C library and kernel headers from its release pocket, which
# never changes, and GCC 12.3's libstdc++ from its updates (the release
# pocket's GCC 12 is a pre-release whose <source_location> clang rejects):
# for x86_64 from a dated snapshot, for ARM64 from the ports archive, which
# has none, each checked against its hash.
SYSROOT_DEBS_amd64=(
  "http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.35-0ubuntu3_amd64.deb ea9a27e0ebdd0cfc9c750d94f8074f3a35d1f97dcc77ae04c370fb498a6b6db2"
  "http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6-dev_2.35-0ubuntu3_amd64.deb cc37cab5c60bcfe4bbf289a8002f369949a41ed46e8b51a0503a001099370c56"
  "http://archive.ubuntu.com/ubuntu/pool/main/l/linux/linux-libc-dev_5.15.0-25.25_amd64.deb 1b2a93020593c9e94a25f750ce442da5a6e8ff48a20f52cec92dfc3fa35336d8"
  "https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/pool/main/g/gcc-12/libgcc-12-dev_12.3.0-1ubuntu1~22.04.3_amd64.deb a9933d9949219f3a0598bf48390091f45c03c036fe736de38f33b7c60eddca0e"
  "https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/pool/main/g/gcc-12/libgcc-s1_12.3.0-1ubuntu1~22.04.3_amd64.deb d383e642d83263147f7b4b69fb92cf1036e5246c6be3accf10b77f986684589a"
  "https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/pool/main/g/gcc-12/libstdc++6_12.3.0-1ubuntu1~22.04.3_amd64.deb 29ef3d289b272704b75141906c8f683db0f2bdb0942061366691333bfb289bdc"
  "https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/pool/universe/g/gcc-12/libstdc++-12-dev_12.3.0-1ubuntu1~22.04.3_amd64.deb 250f538cb3a5dfbbb767e16cb3d840a2b113de1582bec155ea97600740a6ed1e"
  "https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb 56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462"
  "http://archive.ubuntu.com/ubuntu/pool/main/libx/libxcrypt/libcrypt1_4.4.27-1_amd64.deb 3fa566e9f861a08736cbc5a97562d9d6e4f0c00450fbeafcb6d7583423b04a98"
  "http://archive.ubuntu.com/ubuntu/pool/main/libx/libxcrypt/libcrypt-dev_4.4.27-1_amd64.deb a79be2f6e45823dcc09e04d5e98c88ec88d07d5b8895d05b875a8ade8b345efa"
)
SYSROOT_DEBS_arm64=(
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6_2.35-0ubuntu3_arm64.deb b1206b51690a810efc701e1d311e0ac5fd9a9f0f8e216585362512d805d261af"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6-dev_2.35-0ubuntu3_arm64.deb 2f254d6e843e413d549f407362885171c285f08383bb7e9392da855810ff78fd"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/l/linux/linux-libc-dev_5.15.0-25.25_arm64.deb ffbdfcd181d87b92c108cb49ca20e152c0688825b5a1aac9ecbc63391b348aeb"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-12/libgcc-12-dev_12.3.0-1ubuntu1~22.04.3_arm64.deb 370b53ee214186e2e08b5d8dda1835c7a3dbc404651b49e6b9db9a7fb222c847"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-12/libgcc-s1_12.3.0-1ubuntu1~22.04.3_arm64.deb 46626e1af6b159061e055f843654ee1f0f1e65fa280331ed47ee76ba1b1f6045"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-12/libstdc++6_12.3.0-1ubuntu1~22.04.3_arm64.deb 59d244119e6129c7e9c0897491c0e210e925d15881b2dedcf8965ceb4fbf1aa3"
  "http://ports.ubuntu.com/ubuntu-ports/pool/universe/g/gcc-12/libstdc++-12-dev_12.3.0-1ubuntu1~22.04.3_arm64.deb 8b5e4e208168223f7293c1c9ad22a52785a04313be60464db57e1674fec5799b"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_arm64.deb 936154d57c566aebc0842cf0451b694539e61ca65617d707aa89b4db07285eb1"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/libx/libxcrypt/libcrypt1_4.4.27-1_arm64.deb fb5f8d59de95bbb118a635e83e2a92077e13c6d297980dae3119df057bf88111"
  "http://ports.ubuntu.com/ubuntu-ports/pool/main/libx/libxcrypt/libcrypt-dev_4.4.27-1_arm64.deb 17805b64d386655edca4aafbf01e6b89bd3b9a35cde7a31da964dd766ad9c5b6"
)

arch="${1:-}"
case "$arch" in
  amd64) cpu=x64 ;;
  arm64) cpu=arm64 ;;
  *)
    echo "usage: builtins/v8/build.sh amd64|arm64" >&2
    exit 2
    ;;
esac
if [[ "$(uname -s -m)" != "Linux x86_64" ]]; then
  echo "build.sh: builds on x86_64 Linux (ARM64 is cross-compiled)" >&2
  exit 2
fi

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

work="${V8_WORK:-$SCRATCH/v8}"
mkdir -p "$work"
work="$(cd -- "$work" && pwd)"
cd "$work"

# depot_tools, at its pin; it updates itself unless told not to.
export DEPOT_TOOLS_UPDATE=0
if [[ ! -d depot_tools ]]; then
  git clone --quiet https://chromium.googlesource.com/chromium/tools/depot_tools.git depot_tools
fi
git -C depot_tools fetch --quiet origin "$DEPOT_TOOLS_COMMIT"
git -C depot_tools -c advice.detachedHead=false checkout --quiet --force "$DEPOT_TOOLS_COMMIT"
(cd depot_tools && ./ensure_bootstrap)
export PATH="$work/depot_tools:$PATH"

if [[ ! -d custom-builds ]]; then
  git clone --quiet https://github.com/wasmerio/v8-custom-builds.git custom-builds
fi
git -C custom-builds fetch --quiet origin "$CUSTOM_BUILDS_COMMIT"
git -C custom-builds -c advice.detachedHead=false checkout --quiet --force "$CUSTOM_BUILDS_COMMIT"

# V8 at its commit, with the dependencies its DEPS pins (Chromium's clang,
# GN and Ninja among them); hooks off, as upstream, so no test data.
if [[ ! -f .gclient ]]; then
  gclient config --name v8 --unmanaged https://chromium.googlesource.com/v8/v8.git
fi
if [[ ! -d v8/.git ]]; then
  git clone --quiet https://chromium.googlesource.com/v8/v8.git v8
fi
# The commit is the release's tag, and the tag is still that commit.
git -C v8 fetch --quiet origin "refs/tags/$V8_VERSION"
if [[ "$(git -C v8 rev-parse 'FETCH_HEAD^{commit}')" != "$V8_COMMIT" ]]; then
  echo "build.sh: V8's tag $V8_VERSION is not $V8_COMMIT" >&2
  exit 1
fi
git -C v8 -c advice.detachedHead=false checkout --quiet --force "$V8_COMMIT"
# A checkout kept from an earlier run loses that run's patches.
if [[ -d v8/build/.git ]]; then
  gclient recurse --scm=git -- git reset --quiet --hard
fi
git -C v8 clean -fdq
gclient sync --nohooks --force --reset -D --revision "v8@$V8_COMMIT"
(cd v8 && python3 build/util/lastchange.py -o build/util/LASTCHANGE)

for patch in custom-builds/patches/*.patch "$here/v8/no-crel.patch" "$here/v8/global-heap-external.patch"; do
  git -C v8 apply "$(cd -- "$(dirname -- "$patch")" && pwd)/$(basename -- "$patch")"
done

libcxx=false
sysroot="$work/sysroot-jammy-$arch"
rm -rf "$sysroot"
mkdir -p "$sysroot" "$work/debs"
if [[ "$arch" == amd64 ]]; then
  debs=("${SYSROOT_DEBS_amd64[@]}")
else
  debs=("${SYSROOT_DEBS_arm64[@]}")
fi
for entry in "${debs[@]}"; do
  read -r url sha <<<"$entry"
  deb="$work/debs/$(basename -- "$url")"
  if [[ ! -f "$deb" || "$(sha256_of "$deb")" != "$sha" ]]; then
    curl -sSfL -o "$deb" "$url"
  fi
  if [[ "$(sha256_of "$deb")" != "$sha" ]]; then
    echo "build.sh: $url hashed to $(sha256_of "$deb"), not the pinned $sha" >&2
    exit 1
  fi
  dpkg-deb -x "$deb" "$sysroot"
done
# Ubuntu's absolute library symlinks, made relative to the sysroot.
while IFS= read -r link; do
  target="$(readlink "$link")"
  if [[ "$target" == /* ]]; then
    ln -sfn "$sysroot$target" "$link"
  fi
done < <(find "$sysroot" -type l)
# The target toolchain compiles against the sysroot (on x86_64, the build's
# own tools too, which share its CPU); ARM64's build tools, mksnapshot among
# them, run here against this machine's headers.
sysroot_args=(use_sysroot=false "target_sysroot=\"$sysroot\"")

# Upstream's build.sh, its non-iOS arguments.
args=(
  is_debug=false
  v8_symbol_level=0
  symbol_level=0
  is_component_build=false
  is_official_build=false
  "use_custom_libcxx=$libcxx"
  "use_custom_libcxx_for_host=$libcxx"
  "${sysroot_args[@]}"
  use_glib=false
  is_clang=true
  v8_expose_symbols=true
  v8_optimized_debug=false
  v8_enable_sandbox=false
  v8_enable_i18n_support=true
  icu_use_data_file=false
  v8_enable_gdbjit=false
  v8_use_external_startup_data=false
  treat_warnings_as_errors=false
  v8_enable_fast_mksnapshot=true
  v8_enable_handle_zapping=false
  v8_enable_pointer_compression=true
  v8_enable_pointer_compression_shared_cage=false
  v8_deprecation_warnings=false
  v8_enable_temporal_support=false
  v8_enable_ecma402_icu4x=false
  "target_cpu=\"$cpu\""
  "v8_target_cpu=\"$cpu\""
  'target_os="linux"'
)
out="out/release-$arch"
(
  cd v8
  gn gen "$out" --args="${args[*]}"
  ninja_args=()
  [[ -z "${NINJA_JOBS:-}" ]] || ninja_args=(-j "$NINJA_JOBS")
  ./third_party/ninja/ninja ${ninja_args[@]+"${ninja_args[@]}"} -C "$out" wee8
)

# Packaged as upstream packages it: V8's public headers, the Wasm C API
# header and the library as lib/libv8.a.
pkg="$work/pkg-$arch"
rm -rf "$pkg"
mkdir -p "$pkg/include/wasm-c-api" "$pkg/lib"
cp -R v8/include/. "$pkg/include/"
find "$pkg/include" -type f ! -name '*.h' -delete
cp v8/third_party/wasm-api/wasm.h "$pkg/include/wasm-c-api/wasm.h"
cp "v8/$out/obj/libwee8.a" "$pkg/lib/libv8.a"

# Upstream's checks, and ours: no CREL, and no Chromium libc++.
if readelf -rW "$pkg/lib/libv8.a" 2>/dev/null | grep -Eq 'R_X86_64_TPOFF32|R_AARCH64_TLSLE'; then
  echo "build.sh: the archive still has local-exec TLS relocations" >&2
  exit 1
fi
if readelf -SW "$pkg/lib/libv8.a" 2>/dev/null | grep -q '\.crel'; then
  echo "build.sh: the archive has CREL sections" >&2
  exit 1
fi
if nm "$pkg/lib/libv8.a" 2>/dev/null | grep -q 'St4__Cr'; then
  echo "build.sh: the archive uses Chromium's libc++" >&2
  exit 1
fi
if nm -u "$pkg/lib/libv8.a" 2>/dev/null | grep -q '__isoc23_'; then
  echo "build.sh: the archive needs glibc 2.38's C23 functions" >&2
  exit 1
fi

version="$(sed -n 's/^const PREBUILT_V8_VERSION: &str = "\(.*\)";$/\1/p' "$here/../vendor/wasmer-napi/build.rs")"
dest="$dist/v8/${version:?build.rs names no PREBUILT_V8_VERSION}"
mkdir -p "$dest"
archive="$dest/v8-linux-$arch.tar.xz"
# Sorted names, no owners and a fixed time, so a rebuild with the same
# objects gives the same archive.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C "$pkg" -cf - include lib |
  xz -T0 -9 >"$archive"
echo "v8-linux-$arch.tar.xz $(sha256_of "$archive")"
