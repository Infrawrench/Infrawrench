#!/usr/bin/env bash
# The native extensions of the gems gems.txt pins, built for env:ruby as
# WASIX side modules, the way README.md ("Ruby") says to build one, and
# packed into one archive per Ruby minor that `deps: [bundler]` reads
# (crates/iwci-deps/src/bundler/builds.rs):
#
#   gems/build.sh <minor>   build them for that minor (3.4 or 4.0)
#
# A job has no C compiler, so `bundle install` in a job cannot build a
# gem's extension, and the installer cannot either: it runs no code of a
# gem's. These are built here instead, from the same .gem files a lock
# pins (each checked against the SHA-256 in gems.txt, which is the one
# rubygems.org serves and a lock's CHECKSUMS records), against the
# interpreter of the environment's own package: its headers, its
# rbconfig.rb and its libruby-static.a (for mkmf's checks), unpacked from
# the webc environments/build.sh pins. mkmf runs on a native Ruby of the
# same release, given that rbconfig.rb, as in any cross build.
#
# Libraries a gem links are compiled into its module, position-independent,
# from the source the gem itself ships (and its .gem's hash pins):
#
#   nokogiri  libxml2 2.13.9 and libxslt 1.1.43 from its ports/archives,
#             with the patches it applies to them, and its own gumbo
#             parser. Built here and handed to its extconf.rb with
#             --use-system-libraries rather than letting it build them
#             (mini_portile2 runs their configure scripts with a --host
#             their config.sub does not know, and downloads nothing it
#             does not already carry): the same releases and patches, so
#             Nokogiri behaves as its own packaged build, except that
#             Nokogiri::VERSION_INFO says the libraries are "system".
#   sqlite3   SQLite 3.54.1 from its ports/archives, the amalgamation
#             compiled with the options sqlite3-ruby's packaged build uses,
#             handed over the same way (--enable-system-libraries).
#   ffi       libffi from wasix-org's port (pinned by commit below), which
#             calls through WASIX's call_dynamic and makes closures with
#             its closure_* calls (the runner's Wasmer cannot load a
#             closure yet, so ffi's attach_function aborts): Rails loads ffi
#             at boot (Active Storage requires ruby-vips, which requires
#             ffi, and only a missing libvips is an error it expects).
#   puma      no OpenSSL (PUMA_DISABLE_SSL): the interpreter's is linked
#             into it rather than offered to extensions, and a job's server
#             is reached over its loopback, not TLS.
#
# Every input is pinned, and the result is reproducible: source paths are
# mapped away, every file in the archive has the release's date, and the
# archive is sorted. It goes to dist/blobs/ruby-gems/<version>/, with a
# build.json that `iwci publish` uploads as a blob (no manifest: the runner
# pins its digest in crates/iwci/src/gem_builds.rs, which is what to update
# with the digest and size printed at the end).
#
# Linux, x86_64 or aarch64, like build.sh, whose toolchain and native Ruby
# it shares (toolchain.sh, and RUBY_WORK the same way). About fifteen
# minutes per minor after the native Ruby, most of it libxml2. Needs: what
# build.sh needs, pkg-config, and autoconf, automake and libtool with
# libltdl's macros (libltdl-dev on Debian and Ubuntu), since libffi's
# repository has no configure script.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=builtins/environments/ruby/toolchain.sh
source "$self/../toolchain.sh"

if [[ $# -ne 1 ]]; then
  echo "usage: gems/build.sh <minor>   (3.4 or 4.0)" >&2
  exit 2
fi
minor="$1"
read -r RUBY_VERSION RUBY_SHA256 _ BUILT_ON <<<"$(release "$minor")"
RUBY_URL="https://cache.ruby-lang.org/pub/ruby/$minor/ruby-$RUBY_VERSION.tar.gz"
# Our build of these gems for this Ruby: a changed gems.txt or a changed
# build is a new number.
GEMS_BUILD=1
VERSION="$RUBY_VERSION-iwci.$GEMS_BUILD"

# libffi for WASIX: wasix-org's fork of libffi 3.5 with a wasm32 port that
# needs no Emscripten (master: "Make sure global ffi_type structs are not
# modified").
LIBFFI_REPO="https://github.com/wasix-org/libffi.git"
LIBFFI_COMMIT="09cbf7d66d232a01dbb0c88fd5ae65fa9c15f7c7"

# The package the environment pins (environments/build.sh, ruby_pkgs):
# version and SHA-256.
read -r _ PKG_VERSION PKG_SHA256 _ <<<"$(sed -n "s/^    $minor) echo \"\\(.*\\)\" ;;\$/\\1/p" "$self/../../build.sh")"
if [[ -z "$PKG_SHA256" ]]; then
  echo "error: environments/build.sh pins no Ruby $minor package" >&2
  exit 1
fi

# 1. The toolchain, a native Ruby, and the environment's package unpacked.
setup_toolchain
mkdir -p "$work/host-src"
if [[ ! -f "$work/host-src/version.h" ]]; then
  tar -xzf "$(download "$RUBY_URL" "$RUBY_SHA256" "ruby-$RUBY_VERSION.tar.gz")" -C "$work/host-src" --strip-components=1
fi
host_ruby "$work/host-src"
webc="$dist/package/ruby/$PKG_VERSION/ruby.webc"
[[ -f "$webc" ]] || bash "$self/../build.sh" "$minor" >&2
if ! echo "$PKG_SHA256  $webc" | sha256sum -c --status -; then
  echo "error: $webc is not the package environments/build.sh pins ($PKG_SHA256)" >&2
  exit 1
fi
pkg="$work/gems-pkg"
rm -rf "$pkg"
WASMER_DIR="$work/wasmer-home" "$tc/wasmer/bin/wasmer" package unpack "$webc" --out-dir "$pkg" >/dev/null
api="$("$host/bin/ruby" -e 'print RbConfig::CONFIG["ruby_version"]')"
archdir="$pkg/ruby/lib/ruby/$api/wasm32-wasix"
ext_api="$api-static"
if ! grep -qF 'CONFIG["ENABLE_SHARED"] = "no"' "$archdir/rbconfig.rb"; then
  echo "error: expected a Ruby without libruby.so (extension API $ext_api)" >&2
  exit 1
fi
# mkmf reads rbconfig.rb from a directory of its own, naming the package
# as its installed directory: with the package's architecture directory
# itself on the load path, an extconf.rb that loads RubyGems (nio4r's)
# would load the package's monitor.so, which is WebAssembly, into the
# native Ruby.
rbconfig="$work/gems-rbconfig"
rm -rf "$rbconfig"
mkdir -p "$rbconfig"
cp "$archdir/rbconfig.rb" "$rbconfig/"
edit "$rbconfig/rbconfig.rb" 1 "TOPDIR = File.dirname(__FILE__).chomp!(\"/lib/ruby/$api/wasm32-wasix\")" \
  "TOPDIR = \"$pkg/ruby\""

src="$work/gems-src"
deps="$work/gems-deps"
out="$work/gems-out"
rm -rf "$src" "$deps" "$out"
mkdir -p "$src" "$deps/lib/pkgconfig" "$deps/include" "$out"
printf '%s\n' "$ext_api" >"$out/ABI"
map="-ffile-prefix-map=$src/= -ffile-prefix-map=$deps/= -ffile-prefix-map=$work/= -ffile-prefix-map=$pkg/="
# Libraries a gem links are found by pkg-config here, never the machine's.
export PKG_CONFIG_PATH="$deps/lib/pkgconfig" PKG_CONFIG_LIBDIR="$deps/lib/pkgconfig"

# fetch_gem <name> <version> <sha256>: the .gem's files in $src/<name>-<version>.
fetch_gem() {
  local file dir="$src/$1-$2"
  file="$(download "https://rubygems.org/gems/$1-$2.gem" "$3" "$1-$2.gem")"
  mkdir -p "$dir"
  # RubyGems' own reader, which refuses paths that leave the directory.
  "$host/bin/ruby" -rfileutils -rrubygems/package -e '
    pkg = Gem::Package.new(ARGV[0])
    abort "#{ARGV[0]} is #{pkg.spec.full_name}" unless pkg.spec.full_name == ARGV[2]
    pkg.extract_files(ARGV[1])
    File.write(File.join(ARGV[1], ".extensions"), pkg.spec.extensions.map { "#{_1}\n" }.join)
  ' "$file" "$dir" "$1-$2"
}

# pc <name> <version> <cflags> <libs>: a pkg-config file for a library in $deps.
pc() {
  cat >"$deps/lib/pkgconfig/$1.pc" <<PC
prefix=$deps
Name: $1
Description: $1, built by gems/build.sh
Version: $2
Cflags: $3
Libs: $4
PC
}

# autotools <source dir> <configure args...>: a static, position-independent
# library installed into $deps.
autotools() {
  local dir="$1"
  shift
  (
    cd "$dir"
    CC=wasixcc AR=wasixar RANLIB=wasixranlib NM=wasixnm CFLAGS="-O2 $map" \
      ./configure --host=wasm32-unknown-wasi --build="$(uname -m)-linux-gnu" --prefix="$deps" \
      --disable-shared --enable-static --with-pic "$@"
    make -j"$jobs"
    make install
  ) >"$work/$(basename "$dir").log" 2>&1 || {
    tail -n 40 "$work/$(basename "$dir").log" >&2
    echo "error: building $(basename "$dir") failed" >&2
    exit 1
  }
}

# Each gem's libraries and the arguments its extconf.rb takes; the
# environment it runs in is set in build_gem.
prepare() {
  local name="$1" dir="$2"
  case "$name" in
    ffi)
      local libffi="$src/libffi"
      git init -q "$libffi"
      git -C "$libffi" fetch -q --depth 1 "$LIBFFI_REPO" "$LIBFFI_COMMIT"
      git -C "$libffi" checkout -q --detach FETCH_HEAD
      (cd "$libffi" && ./autogen.sh) >"$work/libffi-autogen.log" 2>&1 || {
        tail -n 40 "$work/libffi-autogen.log" >&2
        exit 1
      }
      # As its wasix.sh configures it, with -D__wasix__ (which selects its
      # WASIX calls) through CPPFLAGS rather than wasixcc's own variable.
      CPPFLAGS="-D__wasix__=1" autotools "$libffi" --disable-dependency-tracking --disable-builddir \
        --disable-multi-os-directory --disable-raw-api --disable-docs
      echo "--enable-system-libffi"
      ;;
    io-console)
      # It skips itself on any platform matching /wasi/, which wasm32-wasix
      # does, and WASIX has termios: the same edit ruby-wasix.patch makes to
      # the interpreter's own copy.
      edit "$dir/ext/io/console/extconf.rb" 1 'is_wasi = /wasi/ =~' 'is_wasi = /wasi(?!x)/ =~'
      ;;
    nokogiri)
      local libxml2="$src/libxml2" libxslt="$src/libxslt" patch
      mkdir -p "$libxml2" "$libxslt"
      tar -xJf "$dir/ports/archives/libxml2-2.13.9.tar.xz" -C "$libxml2" --strip-components=1
      tar -xJf "$dir/ports/archives/libxslt-1.1.43.tar.xz" -C "$libxslt" --strip-components=1
      for patch in "$dir"/patches/libxml2/*.patch; do patch -s -d "$libxml2" -p1 <"$patch"; done
      for patch in "$dir"/patches/libxslt/*.patch; do patch -s -d "$libxslt" -p1 <"$patch"; done
      # The options nokogiri's own build gives them (ext/nokogiri/extconf.rb),
      # with the C library's iconv, as it uses on Linux. No zlib (the
      # interpreter's is not offered to extensions), so libxml2 reads no
      # gzipped documents. Its default catalog is /etc/xml/catalog, as a
      # distribution's, rather than one under this machine's $deps.
      autotools "$libxml2" --without-python --without-readline --with-c14n --with-debug --with-threads \
        --with-legacy --with-iconv=yes --without-zlib --without-lzma --sysconfdir=/etc
      autotools "$libxslt" --without-python --without-crypto --with-debug --with-libxml-prefix="$deps"
      # Its gumbo parser compiled into the extension, from the gem's
      # gumbo-parser/ (the packaged build makes a libgumbo.a of the same
      # files with mini_portile2). --disable-xml2-legacy only stops its
      # extconf.rb asking for zlib beside a system libxml2.
      echo "--use-system-libraries --gumbo-dev --disable-xml2-legacy"
      ;;
    sqlite3)
      local sqlite="$src/sqlite"
      mkdir -p "$sqlite"
      tar -xzf "$dir/ports/archives/sqlite-autoconf-3540100.tar.gz" -C "$sqlite" --strip-components=1
      # sqlite3-ruby's packaged build's options (ext/sqlite3/extconf.rb)
      # and its configure script's defaults. No memory-mapped I/O, which
      # WASIX maps by copying.
      # shellcheck disable=SC2086 # $map is several flags
      wasixcc -O2 $map -fvisibility=hidden -DSQLITE_THREADSAFE=1 -DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1 \
        -DSQLITE_USE_URI=1 -DSQLITE_ENABLE_DBPAGE_VTAB=1 -DSQLITE_ENABLE_DBSTAT_VTAB=1 \
        -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_GEOPOLY \
        -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_MAX_MMAP_SIZE=0 \
        -c "$sqlite/sqlite3.c" -o "$sqlite/sqlite3.o"
      wasixar rcsD "$deps/lib/libsqlite3.a" "$sqlite/sqlite3.o"
      cp "$sqlite/sqlite3.h" "$sqlite/sqlite3ext.h" "$deps/include/"
      pc sqlite3 3.54.1 "-I$deps/include" "-L$deps/lib -lsqlite3"
      echo "--enable-system-libraries"
      ;;
  esac
}

# build_gem <name> <version>: each of its extensions, installed as RubyGems
# installs one (`make install` with sitearchdir and sitelibdir at the
# extension directory), into $out/<name>/<version>/.
build_gem() {
  local name="$1" version="$2" dir="$src/$1-$2" ext args
  local dest="$out/$name/$version"
  mkdir -p "$dest"
  local prepared
  prepared="$(prepare "$name" "$dir")"
  read -ra args <<<"$prepared"
  while IFS= read -r ext; do
    [[ -n "$ext" ]] || continue
    if [[ "$(basename "$ext")" != extconf.rb ]]; then
      echo "error: $name-$version: $ext is not an extconf.rb" >&2
      exit 1
    fi
    local log
    log="$work/gem-$name-$(dirname "$ext" | tr / -).log"
    (
      cd "$dir/$(dirname "$ext")"
      # mkmf with the package's rbconfig.rb; -I the gem's own lib, as
      # RubyGems has it when it builds, for an extconf that requires it.
      env PUMA_DISABLE_SSL=1 "$host/bin/ruby" --disable-gems -I "$rbconfig" -r rbconfig -I "$dir/lib" \
        extconf.rb "${args[@]}"
      make -j"$jobs" V=1 debugflags="$map"
      make install V=1 sitearchdir="$dest" sitelibdir="$dest" DESTDIR=
    ) >"$log" 2>&1 || {
      tail -n 60 "$log" >&2
      echo "error: $name-$version: $ext failed (log: $log)" >&2
      exit 1
    }
  done <"$dir/.extensions"
  if ! find "$dest" -name '*.so' | grep -q .; then
    echo "error: $name-$version built no .so" >&2
    exit 1
  fi
}

# 2. Every gem gems.txt pins.
while read -r name version sha; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  fetch_gem "$name" "$version" "$sha"
  build_gem "$name" "$version"
  echo "built $name $version: $(cd "$out/$name/$version" && find . -name '*.so' | sort | tr '\n' ' ')"
done <"$self/gems.txt"

# Nothing in a module may name this machine's directories.
if grep -rlF "$work" "$out"; then
  echo "error: the files above name the work directory" >&2
  exit 1
fi

# 3. The archive, the same bytes for the same inputs.
target="$(out_dir blobs ruby-gems "$VERSION")"
archive="ruby-gems-$minor.tar.gz"
tar --sort=name --mtime="@$BUILT_ON" --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
  -C "$out" -cf - . | gzip -9n >"$target/$archive"
cat >"$target/build.json" <<JSON
{
  "kind": "blobs",
  "name": "ruby-gems",
  "version": "$VERSION",
  "files": [{ "path": "$archive", "file": "$archive" }],
  "description": "Native extensions of the gems in builtins/environments/ruby/gems/gems.txt for CRuby $RUBY_VERSION on WASIX"
}
JSON
echo "built $target/$archive"
echo "  archive $(sha256sum "$target/$archive" | cut -d' ' -f1) ($(stat -c %s "$target/$archive") bytes)"
