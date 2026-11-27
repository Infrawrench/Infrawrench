#!/usr/bin/env bash
#
# The programs the forge's suites (git/packages/*) drive that a
# `platform: linux` machine does not have, or has too old, into a directory
# git.yml caches:
#
#   git-tools.sh <dir> [git] [openssh] [terraform]   then: export PATH="<dir>/bin:$PATH"
#
# With no tool named, all three.
#
# - Git. Ubuntu 24.04 has 2.43, and the suites compare this code with what a
#   current git does: `git merge-file --diff-algorithm` (2.44) does not exist
#   there, and rename detection scores some pairs differently. So git is
#   built from the release the runner's own environments are built from (the
#   same tarball and sum as ci-runner/builtins/environments/git/build.sh),
#   with HTTPS (libcurl) and without what the suites never run (Perl, Python,
#   Tcl/Tk, translations) or what would need another toolchain (`NO_RUST`:
#   the parts written in Rust have their C fallbacks).
# - OpenSSH. Ubuntu 24.04 has 9.6, and the SSH server's interop suite is
#   written against a current client: it expects the post-quantum key
#   exchange (mlkem768x25519-sha256, OpenSSH 9.9 and later) to be what the
#   client picks, and that the client does not print its "not post-quantum"
#   warning (OpenSSH 10). So `ssh` and `ssh-keygen` are built from the
#   portable release, the same tarball and sum as the runner's own builtin
#   (ci-runner/builtins/openssh/build.sh, where its signature was checked).
# - Terraform, for the state backend's suite, which runs the real client
#   against it. The image leaves it out (ci-runner/images/README.md), so it
#   is the release's zip, checked against HashiCorp's published sum.
#
# Nothing is installed system-wide: the directory goes first on the job's
# PATH, and the machine's own git and OpenSSH stay as they are. Each tool is
# skipped when the directory already has that version, which is what a
# restored cache looks like. Nothing here is a secret and nothing is run from
# what is downloaded before its sum is checked.
set -euo pipefail

dir="${1:?usage: git-tools.sh <dir> [git] [openssh] [terraform]}"
shift
want_git=false
want_openssh=false
want_terraform=false
if (($# == 0)); then
  want_git=true
  want_openssh=true
  want_terraform=true
fi
for tool in "$@"; do
  case "$tool" in
    git) want_git=true ;;
    openssh) want_openssh=true ;;
    terraform) want_terraform=true ;;
    *)
      echo "error: unknown tool '$tool' (git, openssh, terraform)" >&2
      exit 2
      ;;
  esac
done
mkdir -p "$dir/bin" "$dir/src"

GIT_RELEASE="2.56.1"
GIT_URL="https://mirrors.edge.kernel.org/pub/software/scm/git/git-$GIT_RELEASE.tar.xz"
GIT_SHA256="f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f"

OPENSSH_RELEASE="10.6p2"
OPENSSH_URL="https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-$OPENSSH_RELEASE.tar.gz"
OPENSSH_SHA256="9ae44872090cf2f06b3cf9ff147e7f16f309671340763ed2f99248398ae29d5b"

TERRAFORM_VERSION="1.15.8"
case "$(uname -m)" in
  x86_64)
    terraform_arch=amd64
    TERRAFORM_SHA256="d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d"
    ;;
  aarch64 | arm64)
    terraform_arch=arm64
    TERRAFORM_SHA256="8891e9dcedc9e3b8950bc6af9d4d8af1f4cfade3062f53b9dc403a89f6ce8c9c"
    ;;
  *)
    echo "error: no Terraform sum pinned for $(uname -m)" >&2
    exit 1
    ;;
esac

# download <url> <sha256> <file>
download() {
  local url="$1" sha="$2" file="$3"
  curl -fsSL --retry 5 --retry-all-errors -o "$file" "$url"
  if ! echo "$sha  $file" | sha256sum -c --status -; then
    echo "error: $url hashed to $(sha256sum "$file" | cut -d' ' -f1), expected $sha" >&2
    rm -f "$file"
    exit 1
  fi
}

# need <package>...: the headers a build wants, installed once.
need() {
  if ! dpkg -s "$@" >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
  fi
}

if $want_git && [[ "$("$dir/bin/git" --version 2>/dev/null)" != "git version $GIT_RELEASE" ]]; then
  echo "building Git $GIT_RELEASE"
  need libcurl4-openssl-dev libssl-dev zlib1g-dev
  src="$dir/src/git"
  rm -rf "$src"
  mkdir -p "$src"
  download "$GIT_URL" "$GIT_SHA256" "$dir/src/git.tar.xz"
  tar -xJf "$dir/src/git.tar.xz" -C "$src" --strip-components=1
  # The same switches for the build and the install, or the install rebuilds.
  make -s -C "$src" -j"$(nproc)" prefix="$dir" \
    NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_EXPAT=1 NO_RUST=1 NO_INSTALL_HARDLINKS=1 \
    all install >/dev/null
  rm -rf "$dir/src"
  mkdir -p "$dir/src"
fi
if $want_git; then "$dir/bin/git" --version; fi

# OpenSSH prints its version on stderr: "OpenSSH_10.6p2, OpenSSL ...".
if $want_openssh && ! "$dir/bin/ssh" -V 2>&1 | grep -q "^OpenSSH_$OPENSSH_RELEASE,"; then
  echo "building OpenSSH $OPENSSH_RELEASE (ssh, ssh-keygen)"
  # The headers its configure needs. RSA and ECDSA keys and AES-GCM are
  # OpenSSL's, and the suite uses all three, so `--without-openssl` is out.
  need libssl-dev zlib1g-dev
  src="$dir/src/openssh"
  rm -rf "$src"
  mkdir -p "$src"
  download "$OPENSSH_URL" "$OPENSSH_SHA256" "$dir/src/openssh.tar.gz"
  tar -xzf "$dir/src/openssh.tar.gz" -C "$src" --strip-components=1
  (
    cd "$src"
    # No PAM, no SELinux, no system configuration: a client that reads only
    # what a test hands it. `--sysconfdir` keeps it from /etc/ssh/ssh_config.
    ./configure --quiet --prefix="$dir" --sysconfdir="$dir/etc" \
      --without-pam --without-selinux --without-kerberos5 --disable-strip >/dev/null
    make -s -j"$(nproc)" ssh ssh-keygen
    install -m 0755 ssh ssh-keygen "$dir/bin/"
  )
  rm -rf "$dir/src"
  mkdir -p "$dir/src"
fi
if $want_openssh; then "$dir/bin/ssh" -V; fi

if $want_terraform && ! "$dir/bin/terraform" version 2>/dev/null | grep -q "^Terraform v$TERRAFORM_VERSION\$"; then
  echo "installing Terraform $TERRAFORM_VERSION"
  zip="$dir/src/terraform.zip"
  download \
    "https://releases.hashicorp.com/terraform/$TERRAFORM_VERSION/terraform_${TERRAFORM_VERSION}_linux_$terraform_arch.zip" \
    "$TERRAFORM_SHA256" "$zip"
  unzip -q -o "$zip" terraform -d "$dir/bin"
  rm -f "$zip"
fi
if $want_terraform; then "$dir/bin/terraform" version | head -1; fi
