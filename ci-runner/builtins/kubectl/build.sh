#!/usr/bin/env bash
# builtin:kubectl: Kubernetes' kubectl, built for WASIX with env:go's
# toolchain, so `tools: [builtin:kubectl@1.37]` puts it on a job's PATH and
# it reaches a cluster over the job's network (sockets come from WASIX, as
# for any Go program the env:go toolchain builds).
#
#   build.sh <minor>   build kubectl <minor> (1.37)
#
# The steps, each pinned:
#
#   1. Go's release archive with env:go's patch series applied
#      (environments/go/build.sh, the same release and hashes, read from that
#      script so there is one pin). Its native toolchain cross-compiles for
#      wasip1, and the series is what gives the program WASIX's sockets.
#   2. `<minor>/go.mod` and `go.sum`: kubectl's own command (`main.go`, the
#      same few lines as kubernetes/cmd/kubectl) over k8s.io/kubectl and
#      k8s.io/component-base at the release's tag, every module pinned by
#      its hash in go.sum, vendored with `go mod vendor`.
#   3. Three vendored packages assume a terminal through
#      golang.org/x/sys/unix, which has nothing for wasip1:
#      github.com/moby/term, k8s.io/kubectl/pkg/util (umask) and
#      k8s.io/kubectl/pkg/util/term (window resizes). Their Unix files are
#      kept off wasip1 (each build line checked before it is changed) and
#      `shims/` gives wasip1 what Windows has: no terminal. A job has none
#      anyway (ci-runner/README.md), so `kubectl exec -it` runs without a
#      TTY, as it does from any CI.
#   4. `go build -trimpath` with the version Kubernetes' own build stamps
#      (hack/lib/version.sh), so `kubectl version` and the client's skew
#      check read the release.
#
# Also builds `fake-apiserver.go` for builtins/test.sh into
# dist/test/kubectl/: a TLS API server just big enough for its jobs.
#
# Linux on x86_64 or arm64. About 2 GB of disk and a few minutes. Needs:
# bash, curl, git, sha256sum, tar, and the internet (Go's archive, modules
# from proxy.golang.org).
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# minor: kubectl release, the commit its tag names in kubernetes/kubectl,
# that tag's date (the build date stamped in), the env:go minor it builds
# with, our build of it (a changed build is a new number after `iwci.`),
# and the sha256 the module must come out with: the build is reproducible
# (the target is wasm, so the host does not change it), and a build that
# comes out different fails here rather than publishing other bytes.
release() {
  case "$1" in
    1.37) echo "1.37.2 b6fd7151e781c4619468e46cfefb5f4728cce747 2026-10-28T12:45:22Z 1.27 1 9ef473de4375f9239cca45b173a26d08e48e9663c18a8149cefce671a09a762a" ;;
    *)
      echo "error: no kubectl $1 here; know 1.37" >&2
      exit 2
      ;;
  esac
}

minor="${1:-1.37}"
read -r version commit date go_minor build module_sha <<<"$(release "$minor")"

# env:go's pin for that Go minor: release, linux-amd64 and linux-arm64
# hashes. One place pins the Go release; this reads it.
go_release="$(sed -n "s/^    ${go_minor//./\\.}) echo \"\(.*\)\" ;;\$/\1/p" "$here/environments/go/build.sh")"
if [[ -z "$go_release" ]]; then
  echo "error: environments/go/build.sh pins no Go $go_minor" >&2
  exit 1
fi
read -r go_version amd64_sha arm64_sha _ <<<"$go_release"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=amd64 go_sha="$amd64_sha" ;;
  Linux-aarch64 | Linux-arm64) arch=arm64 go_sha="$arm64_sha" ;;
  *)
    echo "error: kubectl for WASIX builds on Linux, x86_64 or arm64" >&2
    exit 1
    ;;
esac

work="${KUBECTL_WORK:-$SCRATCH/kubectl}"
mkdir -p "$work/dl"
archive="$work/dl/go$go_version.linux-$arch.tar.gz"
[[ -f "$archive" ]] || curl -fsSL --retry 3 -o "$archive" "https://go.dev/dl/go$go_version.linux-$arch.tar.gz"
if ! echo "$go_sha  $archive" | sha256sum -c --status -; then
  echo "error: go$go_version.linux-$arch.tar.gz hashed to $(sha256sum "$archive" | cut -d' ' -f1), expected $go_sha" >&2
  rm -f "$archive"
  exit 1
fi

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
# Modules come from the proxy and are checked against go.sum.
hostgo() {
  env -i PATH="$goroot/bin:/usr/bin:/bin" HOME="$work/home" GOROOT="$goroot" \
    GOENV=off GOTOOLCHAIN=local GOTELEMETRY=off CGO_ENABLED=0 \
    GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
    GOCACHE="$work/cache" GOMODCACHE="$work/modcache" GOOS=wasip1 GOARCH=wasm "$@"
}

# 2. The module, vendored.
src="$work/src"
rm -rf "$src"
mkdir -p "$src"
cp "$self/main.go" "$self/$minor/go.mod" "$self/$minor/go.sum" "$src/"
(cd "$src" && hostgo GOFLAGS=-mod=mod go mod vendor)

# 3. Off the Unix files, onto the shims. `retag <file> <build line>`: the
# file's build line must still be the one written here, or the vendored
# package changed and this needs a look.
retag() {
  local file="$src/vendor/$1" want="$2"
  if [[ "$(head -n 1 "$file")" != "$want" ]]; then
    echo "error: $1 starts with \`$(head -n 1 "$file")\`, not \`$want\`; check what changed" >&2
    exit 1
  fi
  {
    printf '%s && !wasip1\n' "$want"
    # The old-style line, where there is one, says the same.
    tail -n +2 "$file" | sed 's#^// +build \(.*\)$#// +build \1,!wasip1#'
  } >"$file.new"
  mv "$file.new" "$file"
}
term=github.com/moby/term
retag "$term/term_unix.go" "//go:build !windows"
retag "$term/termios_unix.go" "//go:build !windows"
retag "$term/termios_nonbsd.go" "//go:build !darwin && !freebsd && !netbsd && !openbsd && !windows"
cp "$self/shims/moby-term_wasip1.go" "$src/vendor/$term/term_wasip1.go"
retag "k8s.io/kubectl/pkg/util/umask.go" "//go:build !windows"
cp "$self/shims/kubectl-util-umask_wasip1.go" "$src/vendor/k8s.io/kubectl/pkg/util/umask_wasip1.go"
retag "k8s.io/kubectl/pkg/util/term/resizeevents.go" "//go:build !windows"
# A window that never resizes, as on Windows: the same file.
cp "$src/vendor/k8s.io/kubectl/pkg/util/term/resizeevents_windows.go" \
  "$src/vendor/k8s.io/kubectl/pkg/util/term/resizeevents_wasip1.go"

# 4. The program, stamped as Kubernetes stamps a release.
ldflags="-s -w -buildid="
for pkg in k8s.io/component-base/version k8s.io/client-go/pkg/version; do
  ldflags+=" -X $pkg.gitVersion=v$version -X $pkg.gitMajor=${version%%.*}"
  ldflags+=" -X $pkg.gitMinor=$(cut -d. -f2 <<<"$version") -X $pkg.gitCommit=$commit"
  ldflags+=" -X $pkg.gitTreeState=clean -X $pkg.buildDate=$date"
done
out="$(out_dir builtin kubectl "$version")"
(cd "$src" && hostgo GOFLAGS=-mod=vendor go build -trimpath -ldflags="$ldflags" -o "$out/module.wasm" .)
if ! echo "$module_sha  $out/module.wasm" | sha256sum -c --status -; then
  echo "error: kubectl $version came out as $(sha256sum "$out/module.wasm" | cut -d' ' -f1), not the pinned $module_sha" >&2
  exit 1
fi

cat >"$out/build.json" <<JSON
{
  "kind": "builtin",
  "name": "kubectl",
  "version": "$version",
  "abi": "wasix",
  "module": "module.wasm",
  "description": "kubectl $version for WASIX (iwci.$build)"
}
JSON
echo "built $out ($(du -h "$out/module.wasm" | cut -f1))"

# The test server, with the same toolchain and no modules.
test_out="$dist/test/kubectl"
mkdir -p "$test_out" "$work/fake"
cp "$self/fake-apiserver.go" "$work/fake/main.go"
printf 'module fake\n\ngo 1.25\n' >"$work/fake/go.mod"
(cd "$work/fake" && hostgo GOFLAGS=-mod=mod go build -trimpath -ldflags="-s -w -buildid=" -o "$test_out/fake-apiserver.wasm" .)
echo "built $test_out/fake-apiserver.wasm"
