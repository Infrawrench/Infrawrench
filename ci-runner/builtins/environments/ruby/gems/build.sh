#!/usr/bin/env bash
# The native extensions of the gems gems.txt pins, built for env:ruby as
# WASIX side modules, the way README.md ("Ruby") says to build one, and
# packed into one archive per Ruby minor that `deps: [bundler]` reads
# (crates/iwci-deps/src/bundler/builds.rs):
#
#   gems/build.sh <minor>   build them for that minor (3.4 or 4.0)
#
# ONLY="pg trilogy" builds just those, for working on one; the archive
# then holds only them, so it is not one to pin.
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
#             its closure_* calls (so ffi takes its closures from libffi,
#             --enable-libffi-alloc): Rails loads ffi at boot (Active
#             Storage requires ruby-vips, which requires ffi, and only a
#             missing libvips is an error it expects).
#   pg        libpq from PostgreSQL 18.7, with OpenSSL.
#   mysql2    MariaDB Connector/C 3.4.11 (LGPL; MySQL's own client library
#             builds only with CMake's MySQL server tree), with OpenSSL and
#             its authentication plugins built in.
#   trilogy   OpenSSL, for TLS to the server.
#             OpenSSL is 3.5.9, the interpreter's (toolchain.sh pins it),
#             and like libpq and Connector/C is compiled with hidden
#             symbols: each module keeps its own copy to itself rather
#             than sharing, through the dynamic linker, whichever another
#             module loaded first.
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
GEMS_BUILD=2
VERSION="$RUBY_VERSION-iwci.$GEMS_BUILD"

# libffi for WASIX: wasix-org's fork of libffi 3.5 with a wasm32 port that
# needs no Emscripten (master: "Make sure global ffi_type structs are not
# modified").
LIBFFI_REPO="https://github.com/wasix-org/libffi.git"
LIBFFI_COMMIT="09cbf7d66d232a01dbb0c88fd5ae65fa9c15f7c7"
# libpq, from PostgreSQL's release (the SHA-256 is the one
# ftp.postgresql.org publishes beside it).
POSTGRESQL_URL="https://ftp.postgresql.org/pub/source/v18.7/postgresql-18.7.tar.bz2"
POSTGRESQL_SHA256="441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd"
# MariaDB Connector/C, for mysql2: the v3.4.11 tag's commit.
CONNECTOR_C_REPO="https://github.com/mariadb-corporation/mariadb-connector-c.git"
CONNECTOR_C_COMMIT="be67a4fc1e0493913732df90e562f122bff9dfe3"

# The package the environment pins (environments/build.sh, ruby_pkgs):
# version and SHA-256.
read -r _ PKG_VERSION PKG_SHA256 _ <<<"$(sed -n "s/^    $minor) echo \"\\(.*\\)\" ;;\$/\\1/p" "$self/../../build.sh")"
if [[ -z "$PKG_SHA256" ]]; then
  echo "error: environments/build.sh pins no Ruby $minor package" >&2
  exit 1
fi

# 1. The toolchain, a native Ruby, and the environment's package unpacked.
setup_toolchain
# The release's source, by version: one RUBY_WORK serves both minors, and
# host_ruby rebuilds from this when the native Ruby there is the other one.
host_src="$work/host-src-$RUBY_VERSION"
mkdir -p "$host_src"
if [[ ! -f "$host_src/version.h" ]]; then
  tar -xzf "$(download "$RUBY_URL" "$RUBY_SHA256" "ruby-$RUBY_VERSION.tar.gz")" -C "$host_src" --strip-components=1
fi
host_ruby "$host_src"
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
  run "$(basename "$1")" autotools_steps "$@"
}

autotools_steps() {
  cd "$1"
  shift
  CC=wasixcc AR=wasixar RANLIB=wasixranlib NM=wasixnm CFLAGS="-O2 $map ${EXTRA_CFLAGS:-}" \
    ./configure --host=wasm32-unknown-wasi --build="$(uname -m)-linux-gnu" --prefix="$deps" \
    --disable-shared --enable-static --with-pic "$@"
  make -j"$jobs"
  make install
}

# build_openssl: OpenSSL's libraries in $deps, once, configured as build.sh
# configures the interpreter's (its certificates are the environment's,
# /opt/ruby/ssl/cert.pem), with hidden symbols. Its build compiles relative
# paths, so it is given no -ffile-prefix-map, which OpenSSL_version() would
# report among its flags; and the directories it names for modules and
# engines are the interpreter's, not ones under $deps.
build_openssl() {
  [[ -f "$deps/lib/libssl.a" ]] && return
  local dir="$src/openssl"
  mkdir -p "$dir"
  tar -xzf "$(download "$OPENSSL_URL" "$OPENSSL_SHA256" openssl.tar.gz)" -C "$dir" --strip-components=1
  run openssl openssl_steps "$dir"
}

openssl_steps() {
  cd "$1"
  CC=wasixcc AR=wasixar RANLIB=wasixranlib SOURCE_DATE_EPOCH="$BUILT_ON" ./Configure linux-generic32 \
    no-asm no-shared no-dso no-module no-engine no-tests no-apps no-docs no-afalgeng no-dgram \
    no-secure-memory no-ui-console --prefix="$deps" --openssldir=/opt/ruby/ssl --libdir=lib \
    -fvisibility=hidden
  SOURCE_DATE_EPOCH="$BUILT_ON" make -j"$jobs" build_libs \
    ENGINESDIR=/usr/lib/engines-3 MODULESDIR=/usr/lib/ossl-modules
  make install_dev
}

# libpq_steps <source dir>: libpq, its static library alone, into $deps.
libpq_steps() {
  cd "$1"
  # configure insists on Bison and Flex, which only the server's parsers
  # need (the release has none of their output since PostgreSQL 18);
  # these stand in, and fail if anything does run them.
  mkdir -p "$src/no-parsers"
  # shellcheck disable=SC2016 # the stand-ins' own $1
  printf '#!/bin/sh\n[ "$1" = --version ] && echo "bison (GNU Bison) 3.8.2" && exit 0\nexit 1\n' >"$src/no-parsers/bison"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\n[ "$1" = --version ] && echo "flex 2.6.4" && exit 0\nexit 1\n' >"$src/no-parsers/flex"
  chmod +x "$src/no-parsers/bison" "$src/no-parsers/flex"
  # Linux's template (configure knows no WASI one); the client library
  # alone, so none of the server's options. Its pg_service.conf is
  # /etc/postgresql's, as a distribution's libpq has it, not under $deps.
  CC=wasixcc AR=wasixar RANLIB=wasixranlib CFLAGS="-O2 $map -fvisibility=hidden" \
    CPPFLAGS="-I$deps/include" LDFLAGS="-L$deps/lib" \
    BISON="$src/no-parsers/bison" FLEX="$src/no-parsers/flex" \
    ./configure --host=wasm32-unknown-wasi --build="$(uname -m)-linux-gnu" --prefix="$deps" \
    --sysconfdir=/etc --with-template=linux --with-ssl=openssl --without-readline --without-zlib --without-icu \
    --without-gssapi --without-ldap --without-llvm --disable-nls --without-perl --without-python \
    --without-tcl
  # The headers libpq and its libraries include that are generated (by
  # Perl), not the server's parsers' (by Bison), which every directory's
  # build would otherwise make first (NO_GENERATED_HEADERS).
  make -C src/backend submake-catalog-headers submake-nodes-headers ../../src/include/storage/lwlocknames.h
  make -C src/backend/utils ../../../src/include/utils/header-stamp
  make -C src/include NO_GENERATED_HEADERS=1 install
  make -C src/common NO_GENERATED_HEADERS=1 -j"$jobs" install
  make -C src/port NO_GENERATED_HEADERS=1 -j"$jobs" install
  # The static library alone: linking the shared one (which a module could
  # not use anyway) passes wasm-ld flags it does not know.
  make -C src/interfaces/libpq NO_GENERATED_HEADERS=1 -j"$jobs" all-static-lib
  cp src/interfaces/libpq/libpq.a "$deps/lib/"
  cp src/interfaces/libpq/libpq-fe.h src/interfaces/libpq/libpq-events.h "$deps/include/"
}

# connector_c_steps <source dir>: MariaDB Connector/C's static library and
# headers, into $deps, with its own zlib and every authentication plugin
# compiled in (a job cannot load one from a plugin directory). Its prefix is
# /usr, which it names its plugin directory under; only the headers are
# installed, into $deps.
connector_c_steps() {
  cmake -S "$1" -B "$1/build" -DCMAKE_TOOLCHAIN_FILE="$src/wasix.cmake" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="-O2 $map -fvisibility=hidden" \
    -DCMAKE_INSTALL_PREFIX=/usr -DWITH_SSL=OPENSSL -DOPENSSL_ROOT_DIR="$deps" \
    -DWITH_EXTERNAL_ZLIB=OFF -DWITH_CURL=OFF -DWITH_UNIT_TESTS=OFF -DWITH_MYSQLCOMPAT=OFF \
    -DCLIENT_PLUGIN_DIALOG=STATIC -DCLIENT_PLUGIN_CLIENT_ED25519=STATIC \
    -DCLIENT_PLUGIN_CACHING_SHA2_PASSWORD=STATIC -DCLIENT_PLUGIN_SHA256_PASSWORD=STATIC \
    -DCLIENT_PLUGIN_MYSQL_CLEAR_PASSWORD=STATIC -DCLIENT_PLUGIN_MYSQL_OLD_PASSWORD=OFF \
    -DCLIENT_PLUGIN_AUTH_GSSAPI_CLIENT=OFF -DCLIENT_PLUGIN_REMOTE_IO=OFF
  cmake --build "$1/build" -j"$jobs" --target mariadbclient
  # Its headers as it installs them, and the static library alone
  # (installing the whole project would want the shared one too).
  cmake -DCMAKE_INSTALL_COMPONENT=Development -DCMAKE_INSTALL_PREFIX="$deps" \
    -P "$1/build/include/cmake_install.cmake"
  mkdir -p "$deps/lib/mariadb"
  cp "$1/build/libmariadb/libmariadbclient.a" "$deps/lib/mariadb/"
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
      run libffi-autogen env -C "$libffi" ./autogen.sh
      # As its wasix.sh configures it, with -D__wasix__ (which selects its
      # WASIX calls) through CPPFLAGS rather than wasixcc's own variable.
      CPPFLAGS="-D__wasix__=1" autotools "$libffi" --disable-dependency-tracking --disable-builddir \
        --disable-multi-os-directory --disable-raw-api --disable-docs
      # Closures from libffi (ffi_closure_alloc): by default ffi makes its
      # own trampoline pages and hands libffi their address as the code,
      # and on WebAssembly code is a function table index that only
      # libffi (WASIX's closure_allocate) can give out.
      echo "--enable-system-libffi --enable-libffi-alloc"
      ;;
    trilogy)
      build_openssl
      # Its OpenSSL is ours: dir_config("openssl") would otherwise take the
      # directory the interpreter's configure was given (RbConfig's
      # configure_args), which is not there, and never ask pkg-config.
      echo "--with-openssl-dir=$deps"
      ;;
    pg)
      build_openssl
      local pgsrc="$src/postgresql"
      mkdir -p "$pgsrc"
      tar -xjf "$(download "$POSTGRESQL_URL" "$POSTGRESQL_SHA256" postgresql.tar.bz2)" -C "$pgsrc" --strip-components=1
      run postgresql libpq_steps "$pgsrc"
      # libpq.a needs these beside it, which its own libpq.pc leaves to
      # Libs.private and mkmf's pkg_config does not read.
      pc libpq 18.7 "-I$deps/include" "-L$deps/lib -lpq -lpgcommon_shlib -lpgport_shlib -lssl -lcrypto"
      echo "--with-pg-config=ignore"
      ;;
    mysql2)
      build_openssl
      local mariadb="$src/connector-c"
      git init -q "$mariadb"
      git -C "$mariadb" fetch -q --depth 1 "$CONNECTOR_C_REPO" "$CONNECTOR_C_COMMIT"
      git -C "$mariadb" checkout -q --detach FETCH_HEAD
      cat >"$src/wasix.cmake" <<CMAKE
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER wasixcc)
set(CMAKE_AR "$(command -v wasixar)")
set(CMAKE_RANLIB "$(command -v wasixranlib)")
set(CMAKE_FIND_ROOT_PATH "$deps")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
CMAKE
      run connector-c connector_c_steps "$mariadb"
      # mysql2 reads its flags from a mysql_config, and Connector/C's is a
      # program for WASIX: one that prints them.
      mkdir -p "$deps/bin"
      cat >"$deps/bin/mysql_config" <<SH
#!/bin/sh
case "\$1" in
  --version) echo 3.4.11 ;;
  --include | --cflags) echo "-I$deps/include/mariadb" ;;
  --libs | --libs_r) echo "-L$deps/lib/mariadb -lmariadbclient -L$deps/lib -lssl -lcrypto" ;;
  *) exit 1 ;;
esac
SH
      chmod +x "$deps/bin/mysql_config"
      # Its OpenSSL is ours: it would otherwise take the directory the
      # interpreter's configure was given (RbConfig's configure_args).
      echo "--with-mysql-config=$deps/bin/mysql_config --without-mysql-rpath --with-openssl-dir=$deps"
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

# extension_steps <extconf.rb's dir> <gem's lib dir> <dest> <args...>: one
# extension, built and installed into <dest>.
extension_steps() {
  local dest="$3" lib="$2"
  cd "$1"
  shift 3
  # mkmf with the package's rbconfig.rb; -I the gem's own lib, as RubyGems
  # has it when it builds, for an extconf that requires it.
  env PUMA_DISABLE_SSL=1 "$host/bin/ruby" --disable-gems -I "$rbconfig" -r rbconfig -I "$lib" \
    extconf.rb "$@"
  make -j"$jobs" V=1 debugflags="$map"
  make install V=1 sitearchdir="$dest" sitelibdir="$dest" DESTDIR=
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
    run "gem-$name-$(dirname "$ext" | tr / -)" extension_steps "$dir/$(dirname "$ext")" "$dir/lib" "$dest" \
      ${args[@]+"${args[@]}"}
  done <"$dir/.extensions"
  if ! find "$dest" -name '*.so' | grep -q .; then
    echo "error: $name-$version built no .so" >&2
    exit 1
  fi
  case "$name" in
    pg)
      # Where extconf.rb found libpq, which pg reads only on Windows: what
      # it says when it was built by rake-compiler, rather than this
      # machine's directory.
      printf 'module PG\n\tPOSTGRESQL_LIB_PATH = false\nend\n' >"$dest/pg/postgresql_lib_path.rb"
      ;;
  esac
}

# 2. Every gem gems.txt pins.
while read -r name version sha; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  [[ -z "${ONLY:-}" || " $ONLY " == *" $name "* ]] || continue
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
