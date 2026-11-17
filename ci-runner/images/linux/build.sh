#!/usr/bin/env bash
# The ubuntu-24.04 machine image for `platform: linux` jobs: a kernel and a
# read-only erofs root file system that the runner boots, one QEMU/KVM
# machine per job (ci-runner/images/README.md has the contract).
#
#   build.sh --agent <iwci-guest> --out <vm-dir>/linux [options]
#
#   --agent <path>     iwci-guest built for x86_64-unknown-linux-musl or
#                      aarch64-unknown-linux-musl (the host's architecture)
#   --out <dir>        where vmlinux (x86_64) or Image (aarch64),
#                      rootfs.erofs, image.json and packages.lock go
#   --snapshot <id>    the Ubuntu archive snapshot to install from
#                      (snapshot.ubuntu.com, default below), or `none` for
#                      the live archive
#   --version <v>      the image version (default: the UTC date and time)
#   --work <dir>       scratch space, about 15 GB (default: /var/tmp/...)
#   --jobs <n>         parallel kernel build jobs (default: nproc)
#   --keep-work        keep the scratch directory afterwards
#
# The steps, each pinned:
#
#   1. Linux (the LTS below) from kernel.org, checked against the sha256
#      kernel.org signs in v6.x/sha256sums.asc, configured as `make
#      defconfig` plus kernel.config (merged with merge_config.sh), built
#      with no modules: an uncompressed vmlinux on x86_64 (QEMU's microvm
#      machine boots it through its PVH note), arch/arm64/boot/Image on
#      aarch64.
#   2. `debootstrap --variant=minbase noble` from the archive snapshot, so
#      a rebuild installs the same package versions; debootstrap and apt
#      check everything against the archive's signed indexes.
#   3. packages.txt in a chroot: Ubuntu packages, Docker's packages at
#      pinned versions, and release archives checked against the sha256
#      there.
#   4. The agent at /usr/local/sbin/iwci-guest (it is PID 1), the empty
#      /.iwci/{rw,ws,base,root} it mounts on, /etc/iwci-image.
#   5. `mkfs.erofs --tar=f -zlz4hc` over a tar of the tree, and image.json.
#
# Runs as root on Ubuntu 24.04 of the target architecture (x86_64 or
# aarch64); it cannot cross-build, because packages.txt runs installers in
# a chroot. Needs the internet. Host packages: debootstrap erofs-utils
# (1.7 or later, for --tar) build-essential bc bison flex libelf-dev
# libssl-dev curl gnupg xz-utils file.
set -euo pipefail

self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# 6.18 is the newest longterm series on kernel.org (releases.json,
# 2026-11-17); the sum is the line for linux-6.18.63.tar.xz in
# https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc.
KERNEL_VERSION=6.18.63
KERNEL_SHA256=81764a545072d160748beff4d9de2e7d95aa9f16e8261110288f067a2cc61d71

# https://snapshot.ubuntu.com: the archive as it was at this instant.
DEFAULT_SNAPSHOT=20261116T000000Z

# Docker's apt signing key (https://docs.docker.com/engine/install/ubuntu/).
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

IMAGE=ubuntu-24.04
SUITE=noble

die() {
  echo "error: $*" >&2
  exit 1
}

step() {
  echo "==> $*" >&2
}

usage() {
  sed -n '6,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

agent=""
out=""
snapshot="$DEFAULT_SNAPSHOT"
version="$(date -u +%Y%m%d.%H%M)"
work=""
jobs="$(nproc 2>/dev/null || echo 4)"
keep_work=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) agent="${2:?--agent needs a path}"; shift 2 ;;
    --out) out="${2:?--out needs a directory}"; shift 2 ;;
    --snapshot) snapshot="${2:?--snapshot needs an id or none}"; shift 2 ;;
    --version) version="${2:?--version needs a value}"; shift 2 ;;
    --work) work="${2:?--work needs a directory}"; shift 2 ;;
    --jobs) jobs="${2:?--jobs needs a number}"; shift 2 ;;
    --keep-work) keep_work=1; shift ;;
    -h | --help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$agent" ]] || die "--agent is required (iwci-guest built for the host's musl target)"
[[ -n "$out" ]] || die "--out is required"
[[ "$snapshot" == none || "$snapshot" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] ||
  die "--snapshot must look like $DEFAULT_SNAPSHOT, or be none"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || die "--jobs must be a positive number"

# --- prerequisites -----------------------------------------------------------

[[ $EUID -eq 0 ]] || die "run as root: debootstrap, mount and chroot need it"

[[ -r /etc/os-release ]] || die "no /etc/os-release; this builds on Ubuntu 24.04"
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] ||
  die "this builds on Ubuntu 24.04, not ${PRETTY_NAME:-an unknown system}"

arch="$(uname -m)"
case "$arch" in
  x86_64)
    debarch=amd64
    karch=x86_64
    ktarget=vmlinux
    kfile=vmlinux
    kbuilt=vmlinux
    nodearch=x64
    goarch=amd64
    rusttriple=x86_64-unknown-linux-gnu
    filearch="x86-64"
    sumcol=4
    ;;
  aarch64)
    debarch=arm64
    karch=arm64
    ktarget=Image
    kfile=Image
    kbuilt=arch/arm64/boot/Image
    nodearch=arm64
    goarch=arm64
    rusttriple=aarch64-unknown-linux-gnu
    filearch="ARM aarch64"
    sumcol=5
    ;;
  *) die "unsupported architecture $arch: build on x86_64 or aarch64" ;;
esac

missing=()
for tool in debootstrap mkfs.erofs curl gpg sha256sum tar xz file make gcc bc bison flex perl chroot mount umount mountpoint; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[[ -e /usr/include/libelf.h ]] || missing+=("libelf-dev (libelf.h)")
[[ -e /usr/include/openssl/ssl.h ]] || missing+=("libssl-dev (openssl/ssl.h)")
[[ -e /usr/share/keyrings/ubuntu-archive-keyring.gpg ]] || missing+=("ubuntu-keyring")
[[ ${#missing[@]} -eq 0 ]] || die "missing on this host: ${missing[*]}
  apt-get install debootstrap erofs-utils build-essential bc bison flex libelf-dev libssl-dev curl gnupg xz-utils file ubuntu-keyring"

erofs_version="$(mkfs.erofs --version 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true)"
[[ -n "$erofs_version" ]] || die "cannot tell mkfs.erofs's version"
if [[ "$(printf '%s\n1.7\n' "$erofs_version" | sort -V | head -n 1)" != 1.7 ]]; then
  die "mkfs.erofs $erofs_version is too old: --tar needs erofs-utils 1.7 or later"
fi

[[ -f "$agent" ]] || die "no agent at $agent"
agent_kind="$(file -b "$agent")"
[[ "$agent_kind" == *ELF* && "$agent_kind" == *"$filearch"* ]] ||
  die "$agent is not an $arch ELF binary ($agent_kind)"
[[ "$agent_kind" == *"statically linked"* || "$agent_kind" == *static-pie* ]] ||
  die "$agent is not statically linked; build it for $arch-unknown-linux-musl ($agent_kind)"

# --- layout ------------------------------------------------------------------

mkdir -p "$out"
out="$(cd -- "$out" && pwd)"
if [[ -z "$work" ]]; then
  work="$(mktemp -d /var/tmp/iwci-linux-image.XXXXXX)"
else
  mkdir -p "$work"
  work="$(cd -- "$work" && pwd)"
fi
dl="$work/dl"
root="$work/root"
stage="$work/out"
mkdir -p "$dl" "$stage"

mounted=()
cleanup() {
  local i
  for ((i = ${#mounted[@]} - 1; i >= 0; i--)); do
    umount -l "${mounted[$i]}" 2>/dev/null || true
  done
  if [[ $keep_work -eq 0 ]]; then
    rm -rf "$work"
  else
    echo "scratch kept at $work" >&2
  fi
}
trap cleanup EXIT

# fetch <url> <sha256> <file>: downloads into $dl unless already there with
# the right sum, and fails on any other sum.
fetch() {
  local url="$1" sum="$2" file="$dl/$3"
  if [[ -f "$file" ]] && echo "$sum  $file" | sha256sum -c --status; then
    return
  fi
  curl -fsSL --retry 3 --proto '=https' -o "$file.part" "$url" || die "downloading $url failed"
  if ! echo "$sum  $file.part" | sha256sum -c --status; then
    die "$url has sha256 $(sha256sum "$file.part" | cut -d' ' -f1), expected $sum"
  fi
  mv "$file.part" "$file"
}

sha() {
  sha256sum "$1" | cut -d' ' -f1
}

# release_line <name>: the version and this architecture's sum from
# packages.txt.
release_line() {
  local line
  line="$(awk -v n="$1" -v c="$sumcol" '$1 == "release" && $2 == n { print $3, $c }' "$self/packages.txt")"
  [[ -n "$line" ]] || die "packages.txt has no release line for $1"
  echo "$line"
}

# --- 1. kernel ---------------------------------------------------------------

step "Linux $KERNEL_VERSION ($karch, $ktarget)"
ktar="linux-$KERNEL_VERSION.tar.xz"
fetch "https://cdn.kernel.org/pub/linux/kernel/v${KERNEL_VERSION%%.*}.x/$ktar" "$KERNEL_SHA256" "$ktar"
ksrc="$work/linux-$KERNEL_VERSION"
rm -rf "$ksrc"
tar -C "$work" -xJf "$dl/$ktar"

# This architecture's lines of kernel.config (see its header).
awk -v a="$arch" '
  /^# @arch / { keep = ($3 == "all" || $3 == a); next }
  BEGIN { keep = 1 }
  keep { print }
' "$self/kernel.config" >"$work/kernel.fragment"

kmake() {
  make -C "$ksrc" ARCH="$karch" \
    KBUILD_BUILD_USER=iwci KBUILD_BUILD_HOST=iwci "$@"
}
kmake -s defconfig
(cd "$ksrc" && ARCH="$karch" scripts/kconfig/merge_config.sh -m -O "$ksrc" .config "$work/kernel.fragment" >/dev/null)
kmake -s olddefconfig

dropped=()
while IFS= read -r line; do
  case "$line" in
    CONFIG_*=*)
      grep -qxF "$line" "$ksrc/.config" || dropped+=("$line")
      ;;
    "# CONFIG_"*" is not set")
      symbol="${line#\# }"
      symbol="${symbol%% *}"
      if grep -q "^$symbol=" "$ksrc/.config"; then dropped+=("$line"); fi
      ;;
  esac
done <"$work/kernel.fragment"
[[ ${#dropped[@]} -eq 0 ]] ||
  die "kernel.config lines that did not survive olddefconfig (renamed, or a dependency is off): ${dropped[*]}"

kmake -j"$jobs" "$ktarget"
cp "$ksrc/$kbuilt" "$stage/$kfile"
cp "$ksrc/.config" "$stage/kernel.config"

# --- 2. root file system -----------------------------------------------------

if [[ "$debarch" == amd64 ]]; then
  archive=ubuntu
  live_mirror=http://archive.ubuntu.com/ubuntu
else
  archive=ubuntu-ports
  live_mirror=http://ports.ubuntu.com/ubuntu-ports
fi
if [[ "$snapshot" == none ]]; then
  mirror="$live_mirror"
else
  # Plain http, like the live mirrors: the chroot has no CA certificates
  # until apt installs them, and apt checks every index signature anyway.
  mirror="http://snapshot.ubuntu.com/$archive/$snapshot"
  curl -fsS -o /dev/null "$mirror/dists/$SUITE/InRelease" ||
    die "the snapshot $mirror does not answer; pick another --snapshot, or --snapshot none for the live archive"
fi

step "debootstrap $SUITE ($debarch) from $mirror"
rm -rf "$root"
debootstrap --variant=minbase --arch="$debarch" --components=main,universe \
  --keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg \
  "$SUITE" "$root" "$mirror"

mount -t proc proc "$root/proc"
mounted+=("$root/proc")
mount -t sysfs sysfs "$root/sys"
mounted+=("$root/sys")
mount --bind /dev "$root/dev"
mounted+=("$root/dev")
mount --bind /dev/pts "$root/dev/pts"
mounted+=("$root/dev/pts")

rm -f "$root/etc/resolv.conf"
cp -L /etc/resolv.conf "$root/etc/resolv.conf"
# Nothing starts services in the chroot (and the machine has no init).
printf '#!/bin/sh\nexit 101\n' >"$root/usr/sbin/policy-rc.d"
chmod 0755 "$root/usr/sbin/policy-rc.d"

in_root() {
  chroot "$root" /usr/bin/env -i \
    HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

rm -f "$root/etc/apt/sources.list"
cat >"$root/etc/apt/sources.list.d/ubuntu.sources" <<EOF
Types: deb
URIs: $mirror
Suites: $SUITE $SUITE-updates $SUITE-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

mapfile -t apt_packages < <(awk '$1 == "apt" { print $2 }' "$self/packages.txt")
[[ ${#apt_packages[@]} -gt 0 ]] || die "packages.txt lists no apt packages"
step "apt: ${#apt_packages[@]} packages"
in_root apt-get update
in_root apt-get -y dist-upgrade
in_root apt-get -y install --no-install-recommends "${apt_packages[@]}"

step "Docker's packages"
curl -fsSL --proto '=https' -o "$dl/docker.asc" https://download.docker.com/linux/ubuntu/gpg ||
  die "downloading Docker's signing key failed"
docker_fprs="$(gpg --show-keys --with-colons "$dl/docker.asc" 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }')"
grep -qxF "$DOCKER_KEY_FINGERPRINT" <<<"$docker_fprs" ||
  die "Docker's signing key is not $DOCKER_KEY_FINGERPRINT (got: ${docker_fprs:-nothing})"
install -d -m 0755 "$root/etc/apt/keyrings"
gpg --dearmor <"$dl/docker.asc" >"$root/etc/apt/keyrings/docker.gpg"
cat >"$root/etc/apt/sources.list.d/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $SUITE
Components: stable
Architectures: $debarch
Signed-By: /etc/apt/keyrings/docker.gpg
EOF
mapfile -t docker_packages < <(awk '$1 == "docker" { print $2 "=" $3 }' "$self/packages.txt")
in_root apt-get update
in_root apt-get -y install --no-install-recommends "${docker_packages[@]}"
in_root apt-mark hold "${docker_packages[@]%%=*}" >/dev/null

step "release archives"
read -r v s < <(release_line node)
fetch "https://nodejs.org/dist/v$v/node-v$v-linux-$nodearch.tar.xz" "$s" "node.tar.xz"
tar -C "$root/usr/local" -xJf "$dl/node.tar.xz" --strip-components=1 --no-same-owner \
  --exclude='*/CHANGELOG.md' --exclude='*/README.md'
in_root corepack enable pnpm yarn

read -r v s < <(release_line go)
fetch "https://go.dev/dl/go$v.linux-$goarch.tar.gz" "$s" "go.tar.gz"
rm -rf "$root/usr/local/go"
tar -C "$root/usr/local" -xzf "$dl/go.tar.gz" --no-same-owner
ln -sf ../go/bin/go "$root/usr/local/bin/go"
ln -sf ../go/bin/gofmt "$root/usr/local/bin/gofmt"

read -r v s < <(release_line rustup)
fetch "https://static.rust-lang.org/rustup/archive/$v/$rusttriple/rustup-init" "$s" "rustup-init"
install -m 0755 "$dl/rustup-init" "$root/tmp/rustup-init"
toolchain="$(awk '$1 == "rust" && $2 == "toolchain" { print $3 }' "$self/packages.txt")"
[[ -n "$toolchain" ]] || die "packages.txt has no rust toolchain line"
# Into root's own ~/.rustup and ~/.cargo (jobs run as root with
# HOME=/root), with the proxies linked onto the default PATH: a proxy finds
# its toolchain by the name it was started under, so links work.
in_root /tmp/rustup-init -y --no-modify-path --profile minimal \
  --default-toolchain "$toolchain" -c rustfmt -c clippy
rm -f "$root/tmp/rustup-init"
for proxy in "$root"/root/.cargo/bin/*; do
  ln -sf "/root/.cargo/bin/${proxy##*/}" "$root/usr/local/bin/${proxy##*/}"
done

read -r v s < <(release_line pwsh)
fetch "https://github.com/PowerShell/PowerShell/releases/download/v$v/powershell-$v-linux-$nodearch.tar.gz" "$s" "pwsh.tar.gz"
rm -rf "$root/opt/microsoft/powershell/7"
install -d "$root/opt/microsoft/powershell/7"
tar -C "$root/opt/microsoft/powershell/7" -xzf "$dl/pwsh.tar.gz" --no-same-owner
chmod 0755 "$root/opt/microsoft/powershell/7/pwsh"
ln -sf /opt/microsoft/powershell/7/pwsh "$root/usr/local/bin/pwsh"

read -r v s < <(release_line gh)
fetch "https://github.com/cli/cli/releases/download/v$v/gh_${v}_linux_$goarch.tar.gz" "$s" "gh.tar.gz"
rm -rf "$work/gh"
mkdir -p "$work/gh"
tar -C "$work/gh" -xzf "$dl/gh.tar.gz" --strip-components=1 --no-same-owner
install -m 0755 "$work/gh/bin/gh" "$root/usr/local/bin/gh"

read -r v s < <(release_line kubectl)
fetch "https://dl.k8s.io/release/v$v/bin/linux/$goarch/kubectl" "$s" "kubectl"
install -m 0755 "$dl/kubectl" "$root/usr/local/bin/kubectl"

read -r v s < <(release_line yq)
fetch "https://github.com/mikefarah/yq/releases/download/v$v/yq_linux_$goarch" "$s" "yq"
install -m 0755 "$dl/yq" "$root/usr/local/bin/yq"

# --- 3. what the agent and jobs expect -----------------------------------------

step "agent and machine settings"
install -D -m 0755 "$agent" "$root/usr/local/sbin/iwci-guest"
install -d -m 0755 "$root/.iwci" "$root/.iwci/rw" "$root/.iwci/ws" "$root/.iwci/base" "$root/.iwci/root"
printf '%s' "$IMAGE" >"$root/etc/iwci-image"

# The runner's gateway answers DNS (iwci-vm-proto: GATEWAY_IPV4).
rm -f "$root/etc/resolv.conf"
printf 'nameserver 10.0.2.2\n' >"$root/etc/resolv.conf"
printf 'iwci\n' >"$root/etc/hostname"
cat >"$root/etc/hosts" <<'EOF'
127.0.0.1 localhost
127.0.1.1 iwci
::1 localhost ip6-localhost ip6-loopback
EOF
: >"$root/etc/machine-id"

# Everything above is on the default PATH already; this records the rest
# for shells and anything that reads pam_env's file.
cat >"$root/etc/environment" <<'EOF'
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
LANG="C.UTF-8"
COREPACK_ENABLE_DOWNLOAD_PROMPT="0"
DOTNET_CLI_TELEMETRY_OPTOUT="1"
EOF

# Jobs run as root over files the workspace image owns, and use LFS.
in_root git config --system --add safe.directory '*'
in_root git lfs install --system --skip-repo >/dev/null

# The machine has no init, so nothing runs Docker's daemon until a job
# asks: `iwci-dockerd` starts it (and is a no-op when it is running).
cat >"$root/usr/local/bin/iwci-dockerd" <<'EOF'
#!/bin/sh
# Starts the Docker daemon in a job's machine and waits until it answers.
# The machine has no init system (iwci-guest is PID 1). Docker's storage
# goes on tmpfs: overlay2 cannot put its upper layers on the overlayfs the
# job's root is.
set -eu
if docker info >/dev/null 2>&1; then
  exit 0
fi
if ! grep -q '^cgroup2 /sys/fs/cgroup ' /proc/mounts; then
  mount -t cgroup2 cgroup2 /sys/fs/cgroup
fi
for dir in /var/lib/docker /var/lib/containerd; do
  mkdir -p "$dir"
  mountpoint -q "$dir" || mount -t tmpfs -o mode=0710 tmpfs "$dir"
done
mkdir -p /var/log
nohup dockerd >/var/log/dockerd.log 2>&1 &
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "iwci-dockerd: dockerd did not answer within a minute:" >&2
    tail -n 40 /var/log/dockerd.log >&2
    exit 1
  fi
  sleep 0.5
done
EOF
chmod 0755 "$root/usr/local/bin/iwci-dockerd"

# shellcheck disable=SC2016 # dpkg-query's format, not the shell's
in_root dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' >"$stage/packages.lock"
awk '$1 == "release" || $1 == "rust" { print $2 "\t" $3 "\t" "release" }' "$self/packages.txt" >>"$stage/packages.lock"

step "cleaning up"
in_root apt-get clean
rm -f "$root/usr/sbin/policy-rc.d"
rm -rf "$root"/var/lib/apt/lists/* "$root"/var/cache/apt/* "$root"/var/cache/debconf/*-old \
  "$root"/var/log/* "$root"/tmp/* "$root"/var/tmp/* "$root"/root/.cache \
  "$root"/root/.rustup/downloads "$root"/root/.rustup/tmp "$root"/root/.npm
for ((i = ${#mounted[@]} - 1; i >= 0; i--)); do
  umount "${mounted[$i]}"
done
mounted=()

# --- 4. erofs and image.json -------------------------------------------------

step "rootfs.erofs"
tar -C "$root" --numeric-owner --xattrs --xattrs-include='*' \
  --exclude='./proc/*' --exclude='./sys/*' --exclude='./dev/*' \
  -cf "$work/rootfs.tar" .
mkfs.erofs -zlz4hc,12 -L iwci-root --tar=f "$stage/rootfs.erofs" "$work/rootfs.tar"
rm -f "$work/rootfs.tar"

kernel_sha="$(sha "$stage/$kfile")"
rootfs_sha="$(sha "$stage/rootfs.erofs")"
agent_sha="$(sha "$agent")"
cat >"$stage/image.json" <<EOF
{
  "os": "linux",
  "image": "$IMAGE",
  "arch": "$arch",
  "version": "$version",
  "kernel": "$kfile",
  "kernel_version": "$KERNEL_VERSION",
  "kernel_sha256": "$kernel_sha",
  "rootfs_sha256": "$rootfs_sha",
  "agent_sha256": "$agent_sha",
  "snapshot": "$snapshot"
}
EOF

# Replace the old image only once the new one is whole.
for f in "$kfile" kernel.config rootfs.erofs packages.lock image.json; do
  mv -f "$stage/$f" "$out/$f"
done
step "done: $out ($IMAGE $version, $arch)"
