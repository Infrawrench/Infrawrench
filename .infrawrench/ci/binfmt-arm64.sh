#!/usr/bin/env bash
#
# Lets a `platform: linux` machine run arm64 programs, and so arm64
# containers (`docker run --platform linux/arm64`, `docker buildx build
# --platform linux/arm64`), under QEMU's user-mode emulation.
#
# The runners' machines are x86_64, where GitHub Actions had an arm64 runner
# of its own for these jobs. Emulation is several times slower than native,
# so only jobs whose arm64 half is small use it.
#
# The machine has no init, so nothing registers the handler Ubuntu's
# qemu-user-static package ships (systemd-binfmt would): this writes the
# package's own rule into binfmt_misc. Its `F` flag opens the interpreter
# now, so it works inside containers, which do not have /usr/bin.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends qemu-user-static >/dev/null

if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
  sudo mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
fi
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  rule=/usr/lib/binfmt.d/qemu-aarch64-static.conf
  [ -r "$rule" ] || {
    echo "error: $rule is missing; the qemu-user-static package changed where it keeps its rules" >&2
    exit 1
  }
  sudo sh -c "cat '$rule' > /proc/sys/fs/binfmt_misc/register"
fi
grep -q '^enabled' /proc/sys/fs/binfmt_misc/qemu-aarch64
echo "arm64 programs run under $(sed -n 's/^interpreter //p' /proc/sys/fs/binfmt_misc/qemu-aarch64)"
