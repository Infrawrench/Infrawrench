#!/usr/bin/env bash
# builtin:gh: the GitHub CLI, built for WASIX with env:go's toolchain, so
# `tools: [builtin:gh@2.104]` puts `gh` on a job's PATH and it reaches
# GitHub over the job's network (sockets come from WASIX, as for any Go
# program the env:go toolchain builds), with the token a job is lent
# (`github-token:`, `GH_TOKEN`).
#
#   build.sh <minor>   build gh <minor> (2.104)
#
# The steps, each pinned:
#
#   1. Go's release archive with env:go's patch series applied
#      (environments/go/build.sh, the same release and hashes, read from that
#      script so there is one pin). Its native toolchain cross-compiles for
#      wasip1, and the series is what gives the program WASIX's sockets and
#      processes (gh starts `git` for some commands).
#   2. cli/cli at the release's tag, checked against the commit pinned
#      here, its modules vendored with `go mod vendor` and checked against
#      its go.sum.
#   3. Seven packages have nothing for wasip1, each because it assumes a
#      terminal, signals, a clipboard, file locks or process groups, none of which a job
#      has. Where a package has a file for "other" systems, wasip1 is added
#      to its build line; otherwise its Unix file is kept off wasip1 and
#      `shims/` gives wasip1 what a console that is not a terminal gets.
#      Each build line is checked before it is changed, so an upstream
#      change stops the build here rather than slipping through.
#   4. `go build -trimpath` with the version gh's own build stamps
#      (`internal/build`), so `gh --version` reads the release.
#
# The package carries Mozilla's CA certificates (the bundle env:go pins)
# and sets SSL_CERT_FILE to them: Go's wasip1 port looks in no default
# place, and env:bash has no bundle of its own.
#
# Also builds `fake-github.go` for builtins/test.sh into dist/test/gh/: a
# GitHub (REST, GraphQL and Git over HTTPS) just big enough for its jobs.
#
# Linux on x86_64 or arm64. About 2 GB of disk and a few minutes. Needs:
# bash, curl, git, sha256sum, tar, and the internet (Go's archive, gh's
# source, modules from proxy.golang.org, the CA bundle).
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# minor: gh release, the commit its tag names in cli/cli, that tag's date
# (the build date stamped in), the env:go minor it builds with, our build
# of it (a changed build is a new number after `iwci.`), and the sha256 the
# module must come out with: the build is reproducible (the target is wasm,
# so the host does not change it), and a build that comes out different
# fails here rather than publishing other bytes.
release() {
  case "$1" in
    2.104) echo "2.104.0 3d5a9e355a837f2f5ee78d7484c118cc1342ad1a 2026-11-12 1.27 1 4cffb628a46a4041e7c13dfd56604f473ac19d52fd17175e869f5df79d70c74c" ;;
    *)
      echo "error: no gh $1 here; know 2.104" >&2
      exit 2
      ;;
  esac
}

minor="${1:-2.104}"
read -r version commit date go_minor build module_sha <<<"$(release "$minor")"

# env:go's pins: the Go release with its linux-amd64 and linux-arm64
# hashes, and Mozilla's CA bundle. One place pins each; this reads them.
go_release="$(sed -n "s/^    ${go_minor//./\\.}) echo \"\(.*\)\" ;;\$/\1/p" "$here/environments/go/build.sh")"
cacert_url="$(sed -n 's/^CACERT_URL="\(.*\)"$/\1/p' "$here/environments/go/build.sh")"
cacert_sha="$(sed -n 's/^CACERT_SHA256="\(.*\)"$/\1/p' "$here/environments/go/build.sh")"
if [[ -z "$go_release" || -z "$cacert_url" || -z "$cacert_sha" ]]; then
  echo "error: environments/go/build.sh pins no Go $go_minor or no CA bundle" >&2
  exit 1
fi
read -r go_version amd64_sha arm64_sha _ <<<"$go_release"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=amd64 go_sha="$amd64_sha" ;;
  Linux-aarch64 | Linux-arm64) arch=arm64 go_sha="$arm64_sha" ;;
  *)
    echo "error: gh for WASIX builds on Linux, x86_64 or arm64" >&2
    exit 1
    ;;
esac

work="${GH_WORK:-$SCRATCH/gh}"
mkdir -p "$work/dl"
# download <url> <sha256> <name>: the file, fetched once and checked.
download() {
  local url="$1" sha="$2" file="$work/dl/$3"
  [[ -f "$file" ]] || curl -fsSL --retry 3 -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    rm -f "$file"
    exit 1
  fi
  printf '%s\n' "$file"
}
archive="$(download "https://go.dev/dl/go$go_version.linux-$arch.tar.gz" "$go_sha" "go$go_version.linux-$arch.tar.gz")"
cacert="$(download "$cacert_url" "$cacert_sha" cacert.pem)"

# 1. The toolchain, with env:go's series.
goroot="$work/go$go_version"
rm -rf "$goroot"
mkdir -p "$goroot"
tar -xzf "$archive" -C "$goroot" --strip-components=1
for patch in "$here/environments/go/$go_minor"/*.patch; do
  git -C "$goroot" apply --whitespace=nowarn "$patch" || {
    echo "error: $(basename "$patch") does not apply to go$go_version" >&2
    exit 1
  }
done
# The native go command, with nothing from this machine's configuration.
# Modules come from the proxy and are checked against go.sum, into a cache
# left writable (`-modcacherw`) so the scratch directory can be removed.
hostgo() {
  env -i PATH="$goroot/bin:/usr/bin:/bin" HOME="$work/home" GOROOT="$goroot" \
    GOENV=off GOTOOLCHAIN=local GOTELEMETRY=off CGO_ENABLED=0 \
    GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
    GOCACHE="$work/cache" GOMODCACHE="$work/modcache" GOOS=wasip1 GOARCH=wasm "$@"
}

# 2. The source at the tag, which must name the pinned commit, vendored.
src="$work/src"
rm -rf "$src"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$version" \
  https://github.com/cli/cli.git "$src"
if [[ "$(git -C "$src" rev-parse HEAD)" != "$commit" ]]; then
  echo "error: cli/cli v$version is $(git -C "$src" rev-parse HEAD), not the pinned $commit" >&2
  exit 1
fi
(cd "$src" && hostgo GOFLAGS="-mod=mod -modcacherw" go mod vendor)

# 3. Each change checks the build line it changes: `<file> <build line>`
# must still start with that line, or the package changed and this needs
# a look.
check_line() {
  if [[ "$(head -n 1 "$src/$1")" != "$2" ]]; then
    echo "error: $1 starts with \`$(head -n 1 "$src/$1")\`, not \`$2\`; check what changed" >&2
    exit 1
  fi
}
# retag <file> <build line>: keep a Unix file off wasip1.
retag() {
  local file="$src/$1"
  check_line "$1" "$2"
  {
    printf '//go:build (%s) && !wasip1\n' "${2#//go:build }"
    # The old-style line, where there is one, says the same.
    tail -n +2 "$file" | sed 's#^// +build \(.*\)$#// +build \1\n// +build !wasip1#'
  } >"$file.new"
  mv "$file.new" "$file"
}
# widen <file> <build line>: build a file for "other" systems on wasip1 too.
widen() {
  local file="$src/$1"
  check_line "$1" "$2"
  {
    printf '%s || wasip1\n' "$2"
    tail -n +2 "$file" | sed 's#^// +build \(.*\)$#// +build \1 wasip1#'
  } >"$file.new"
  mv "$file.new" "$file"
}
v=vendor
# A clipboard: none (clipboard.Unsupported, as without xsel on Linux).
cp "$self/shims/clipboard_wasip1.go" "$src/$v/github.com/atotto/clipboard/clipboard_wasip1.go"
# Prompts: no terminal modes to set.
retag "$v/github.com/AlecAivazis/survey/v2/terminal/runereader_posix.go" "//go:build !windows"
cp "$self/shims/survey-runereader_wasip1.go" "$src/$v/github.com/AlecAivazis/survey/v2/terminal/runereader_wasip1.go"
# Colours: what termenv gives js and plan9, which have no terminal either.
widen "$v/github.com/muesli/termenv/termenv_other.go" "//go:build js || plan9 || aix"
# File locks: none.
retag "internal/flock/flock_unix.go" "//go:build !windows"
cp "$self/shims/flock_wasip1.go" "$src/internal/flock/flock_wasip1.go"
# Bubble Tea: no raw mode, resizes or suspending.
cp "$self/shims/bubbletea_wasip1.go" "$src/$v/charm.land/bubbletea/v2/tty_wasip1.go"
# Telemetry's child: no process group of its own.
retag "internal/telemetry/detach_unix.go" "//go:build !windows"
cp "$self/shims/telemetry-detach_wasip1.go" "$src/internal/telemetry/detach_wasip1.go"
# in-toto: whether a directory is writable, from its mode, as on Windows.
retag "$v/github.com/in-toto/in-toto-golang/in_toto/util_unix.go" "//go:build linux || darwin || !windows"
cp "$src/$v/github.com/in-toto/in-toto-golang/in_toto/util_windows.go" \
  "$src/$v/github.com/in-toto/in-toto-golang/in_toto/util_wasip1.go"

# 4. The program, stamped as gh's own build stamps a release.
ldflags="-s -w -buildid= -X github.com/cli/cli/v2/internal/build.Version=$version"
ldflags+=" -X github.com/cli/cli/v2/internal/build.Date=$date"
out="$(out_dir builtin gh "$version")"
(cd "$src" && hostgo GOFLAGS="-mod=vendor -modcacherw" go build -trimpath -buildvcs=false -ldflags="$ldflags" -o "$out/module.wasm" ./cmd/gh)
if ! echo "$module_sha  $out/module.wasm" | sha256sum -c --status -; then
  echo "error: gh $version came out as $(sha256sum "$out/module.wasm" | cut -d' ' -f1), not the pinned $module_sha" >&2
  exit 1
fi
cp "$cacert" "$out/ca-certificates.crt"

cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "gh",
  "version": "$version",
  "abi": "wasix",
  "module": "module.wasm",
  "files": [{ "path": "/usr/share/gh/ca-certificates.crt", "file": "ca-certificates.crt" }],
  "env": { "SSL_CERT_FILE": "/usr/share/gh/ca-certificates.crt", "GH_NO_UPDATE_NOTIFIER": "1", "GH_PROMPT_DISABLED": "1", "GH_TELEMETRY": "disabled" },
  "description": "GitHub CLI $version for WASIX (iwci.$build)"
}
JSON
echo "built $out ($(du -h "$out/module.wasm" | cut -f1))"

# The test server, with the same toolchain and no modules.
test_out="$dist/test/gh"
mkdir -p "$test_out" "$work/fake"
cp "$self/fake-github.go" "$work/fake/main.go"
printf 'module fake\n\ngo 1.25\n' >"$work/fake/go.mod"
(cd "$work/fake" && hostgo GOFLAGS="-mod=mod -modcacherw" go build -trimpath -ldflags="-s -w -buildid=" -o "$test_out/fake-github.wasm" .)
echo "built $test_out/fake-github.wasm"
