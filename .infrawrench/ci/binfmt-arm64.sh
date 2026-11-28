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
# The machine has no init, so nothing registers a handler for the
# interpreter Ubuntu's qemu-user-static package installs (systemd-binfmt or
# binfmt-support would): this writes the rule into binfmt_misc itself. Its
# `F` flag opens the interpreter now, so it works inside containers, which
# do not have it.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends qemu-user-static >/dev/null

if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
  sudo mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
fi
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  # The package's own rule where it ships one in systemd's format, and
  # otherwise QEMU's (scripts/qemu-binfmt-conf.sh: an aarch64 ELF
  # executable's header), with the interpreter the package installed.
  rule="$(find /usr/lib/binfmt.d -name 'qemu-aarch64*.conf' 2>/dev/null | head -n 1)"
  if [ -n "$rule" ]; then
    sudo sh -c "cat '$rule' > /proc/sys/fs/binfmt_misc/register"
  else
    interpreter="$(command -v qemu-aarch64-static)"
    magic='\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00'
    mask='\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
    printf ':qemu-aarch64:M::%s:%s:%s:F' "$magic" "$mask" "$interpreter" |
      sudo tee /proc/sys/fs/binfmt_misc/register >/dev/null
  fi
fi
grep -q '^enabled' /proc/sys/fs/binfmt_misc/qemu-aarch64
echo "arm64 programs run under $(sed -n 's/^interpreter //p' /proc/sys/fs/binfmt_misc/qemu-aarch64)"
