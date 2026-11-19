#!/usr/bin/env bash
# GNU tar for the `bash` and `bash-node` environments, built from its
# release for WASIX with wasixcc (the toolchain git/build.sh pins,
# wasix-toolchain.sh), as `iwci/tar` (`tar` on PATH).
#
# Wasmer's own `wasmer/tar` is built without fork(), which tar uses to
# start a compressor, so `tar -z` (and -j, -J, --use-compress-program)
# failed with "Cannot fork". Two patches to tar's source:
#
#   tar-spawn.patch (SPAWN_WITHOUT_FORK). tar starts the compressor or
#     decompressor in a child tar it forks, which execs it (or, for a pipe,
#     a device or a remote archive, forks once more and reblocks). Here
#     tar starts it with posix_spawn() instead, with the archive (or tar's
#     own standard input or output, for "-") and a pipe to tar as its
#     standard streams, trying each decompressor as tar would. A remote
#     archive (rmt) needs the child tar, so it is refused.
#     `--to-command`, `--info-script`, `--checkpoint-action=exec` and `tar
#     --interactive`'s shell still fork: they get a fork() that fails with
#     ENOSYS (lib/nofork.h), so they report "Cannot fork" as before.
#
#   tar-opendirat.patch. gnulib's `opendirat(int, char const *, int, int *)`
#     clashes with the C library's own `opendirat(int, const char *)`, so
#     gnulib's is `gl_opendirat` here (it has one caller, backupfile.c).
#
# Every input is pinned by content hash, and the build is reproducible: the
# same bytes every time, which `environments/build.sh` checks against the
# hash it pins. Source paths are mapped away (`-ffile-prefix-map`) and the
# package's files carry the release tarball's date. The result goes to
# dist/package/tar/<version>/.
#
# Linux, x86_64 or aarch64. About two minutes on four cores.
# TAR_WORK keeps the downloads and the toolchain somewhere of your choosing
# (default: a scratch directory removed on exit).
#
# Needs: bash, curl, git, make, sha256sum, tar, xz.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Our build of GNU tar 1.35. A changed build is a new number after `iwci.`.
VERSION="1.35.0-iwci.1"
TAR_URL="https://ftp.gnu.org/gnu/tar/tar-1.35.tar.xz"
TAR_SHA256="4d62ff37342ec7aed748535323930c7cf94acf71c3591882b26a7ea50f3edc16"
# The tarball's own date (2023-07-18), which every file in the package is
# given.
BUILT_ON="202307181200.00" # touch -t, in UTC

work="${TAR_WORK:-$SCRATCH/tar}"
# shellcheck source=builtins/environments/wasix-toolchain.sh
source "$self/../wasix-toolchain.sh"

src="$work/src"
rm -rf "$src"
mkdir -p "$src"
tar -xJf "$(download "$TAR_URL" "$TAR_SHA256" tar.tar.xz)" -C "$src" --strip-components=1
for patch in tar-opendirat.patch tar-spawn.patch; do
  patch -s -d "$src" -p1 <"$self/$patch"
done
jobs="${CARGO_BUILD_JOBS:-$(nproc)}"
(
  cd "$src"
  # No ACLs, SELinux, extended attributes or translations: none exists in
  # a job. The C library declares getgroups() with gid_t, which configure
  # cannot find out by linking (it has none to link), so it is told.
  ac_cv_type_getgroups=gid_t CC=wasixcc AR=wasixar RANLIB=wasixranlib \
    CFLAGS="-O2 -DSPAWN_WITHOUT_FORK -ffile-prefix-map=$src/=" \
    ./configure --host=wasm32-unknown-wasi --prefix=/usr --disable-nls --disable-acl \
    --without-selinux --without-xattrs --without-posix-acls --disable-gcc-warnings
  make -j"$jobs"
) >"$work/tar.log" 2>&1 || {
  tail -n 60 "$work/tar.log" >&2
  exit 1
}

package="$work/package"
rm -rf "$package"
mkdir -p "$package/modules" "$package/share/tar"
wasm-opt -O2 --emit-exnref --strip-debug --strip-producers -o "$package/modules/tar" "$src/src/tar"
cp "$src/COPYING" "$package/share/tar/COPYING"
cat >"$package/wasmer.toml" <<'TOML'
[package]
entrypoint = "tar"

[fs]
"/usr/share/tar" = "./share/tar"

[[module]]
name = "tar"
source = "./modules/tar"

[[command]]
name = "tar"
module = "tar"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
atom = "tar"
TOML
# A webc records each file's modification time.
find "$package" -exec env TZ=UTC0 touch -h -t "$BUILT_ON" {} +
out="$(out_dir package tar "$VERSION")"
export WASMER_DIR="$work/wasmer-home"
"$tc/wasmer/bin/wasmer" package build --quiet -o "$out/tar.webc" "$package"

echo "built $out/tar.webc"
echo "  tar  $(sha256sum "$package/modules/tar" | cut -d' ' -f1) ($(wc -c <"$package/modules/tar") bytes)"
echo "  package $(sha256sum "$out/tar.webc" | cut -d' ' -f1)"
