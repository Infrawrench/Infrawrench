#!/usr/bin/env bash
# Installs or reconfigures one CI runner host. Run by Terraform
# (infra/ci-runners) as root, with its inputs in /tmp. Idempotent.
set -euo pipefail

id iwci >/dev/null 2>&1 || useradd --system --home-dir /var/lib/iwci --shell /usr/sbin/nologin iwci
install -d -o iwci -g iwci -m 0755 /opt/iwci/bin
install -d -o iwci -g iwci -m 0750 /var/lib/iwci /var/lib/iwci/cache
install -d -o root -g iwci -m 0750 /etc/iwci

# The binary only when there is none: after that the runner updates itself
# from its release channel, and an older upload must not undo that.
if [[ ! -x /opt/iwci/bin/iwci ]]; then
  install -o iwci -g iwci -m 0755 /tmp/iwci.upload /opt/iwci/bin/iwci
  echo "installed iwci $(/opt/iwci/bin/iwci version)"
else
  echo "keeping iwci $(/opt/iwci/bin/iwci version) (it updates itself)"
fi
rm -f /tmp/iwci.upload

install -o root -g iwci -m 0640 /tmp/iwci.env /etc/iwci/iwci.env
install -o root -g root -m 0644 /tmp/iwci.service /etc/systemd/system/iwci.service
rm -f /tmp/iwci.env /tmp/iwci.service

# Core dumps, so a crash of the runner leaves a backtrace (#947): the unit
# raises its core limit, systemd-coredump keeps each core compressed in
# /var/lib/systemd/coredump within its own size limits, and gdb reads them
# (`coredumpctl gdb iwci`). Ubuntu's apport would take the kernel's core
# pattern back at boot, so it goes off.
if ! command -v coredumpctl >/dev/null || ! command -v gdb >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q systemd-coredump gdb
  else
    echo "warning: no apt; install systemd-coredump and gdb yourself to keep cores" >&2
  fi
fi
if systemctl list-unit-files apport.service >/dev/null 2>&1; then
  systemctl disable --now apport >/dev/null 2>&1 || true
fi
if [[ -f /usr/lib/sysctl.d/50-coredump.conf ]]; then
  sysctl -q -p /usr/lib/sysctl.d/50-coredump.conf
fi

# Unattended upgrades run needrestart, which restarts every service using an
# upgraded library. For iwci that is a drain to stop: it takes no new jobs
# until its longest job ends, and a release that arrives meanwhile waits for
# it. iwci moves only through its own release channel, so needrestart leaves
# it alone.
if [[ -d /etc/needrestart ]]; then
  install -d -m 0755 /etc/needrestart/conf.d
  # shellcheck disable=SC2016 # Perl, not shell: the $ is literal.
  printf '%s\n' '# Written by the iwci install script: iwci updates through its release channel.' \
    '$nrconf{override_rc}{qr(^iwci\.service$)} = 0;' >/etc/needrestart/conf.d/iwci.conf
fi

# Compressed swap in RAM (zram), for a host whose runner admits jobs by
# what they are expected to hold (`memory_admission = "estimate"`): the net
# under an estimate that was wrong. Without it a host that runs out of
# memory kills the runner and every run on it; with it the kernel compresses
# the pages touched least (the runner's own heap for each run is the large
# cold block, about 3:1 with zstd) and the runner stops admitting jobs
# while the host says it is short (`ci-runner/README.md`, "Limits").
#
# - Size: `zram` in `hosts`, the most the device takes uncompressed. Full,
#   a 12 GiB device holds about 4 GiB of RAM. RAM only: nothing a job held
#   reaches a disk.
# - zstd, not the default lzo-rle: what is swapped is cold, so the ratio
#   matters more than the speed.
# - Priority 100, above any disk swap the host already has, which is then
#   used only once zram is full. A disk swap can hold job memory, secrets
#   included, so the script says so when it finds one; removing it is the
#   operator's call.
# - vm.swappiness 150: reading a page back from zram costs microseconds,
#   reading a dropped page of the runner's cache back from a network disk
#   costs a fraction of a millisecond, so anonymous memory goes first.
#   vm.page-cluster 0: no read-ahead from a device with no seek to save.
# - The unit's cgroup: `iwci.service` sets no `MemoryMax=`, so the limit is
#   the host's and the unit swaps as the host does (`MemorySwapMax=` is
#   unset, which is unlimited). Should a `MemoryMax=` be added, reclaim in
#   the unit's cgroup swaps to zram as well, but the compressed pages are
#   the kernel's, not the unit's: `MemoryMax` plus a third of the zram size
#   has to stay under the host's memory, and `MemorySwapMax=0` would take
#   the net away.
zram_size="$(cat /tmp/iwci-zram 2>/dev/null || true)"
rm -f /tmp/iwci-zram
if [[ -n "$zram_size" ]]; then
  if ! modinfo zram >/dev/null 2>&1; then
    # Ubuntu's cloud kernels keep zram in the extra modules package.
    if command -v apt-get >/dev/null; then
      apt-get update -q
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q "linux-modules-extra-$(uname -r)"
      echo "installed linux-modules-extra-$(uname -r) for zram; a kernel upgrade needs its own"
    else
      echo "warning: this kernel has no zram module and there is no apt to install it with" >&2
    fi
  fi
  cat >/usr/local/sbin/iwci-zram <<'ZRAM'
#!/usr/bin/env bash
# Written by the iwci install script: compressed swap in RAM for the CI
# runner's host. `start` makes one zram swap device of $IWCI_ZRAM_SIZE
# unless one is in use already; `stop` swaps it back in and frees it.
set -euo pipefail
devices() { awk 'NR > 1 && $1 ~ /^\/dev\/zram/ { print $1 }' /proc/swaps; }
case "${1:-}" in
  start)
    modprobe zram
    if [[ -n "$(devices)" ]]; then
      echo "zram swap already in use: $(devices | tr '\n' ' ')"
      exit 0
    fi
    device="$(zramctl --find --size "$IWCI_ZRAM_SIZE" --algorithm zstd)"
    mkswap --label iwci-zram "$device" >/dev/null
    swapon --priority 100 "$device"
    echo "zram swap on $device ($IWCI_ZRAM_SIZE, zstd)"
    ;;
  stop)
    for device in $(devices); do
      swapoff "$device"
      zramctl --reset "$device"
    done
    ;;
  *)
    echo "usage: iwci-zram start|stop" >&2
    exit 2
    ;;
esac
ZRAM
  chmod 0755 /usr/local/sbin/iwci-zram
  cat >/etc/systemd/system/iwci-zram.service <<UNIT
# Written by the iwci install script (infra/ci-runners); edits here are overwritten.
[Unit]
Description=Compressed swap in RAM for the CI runner's host
Before=iwci.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=IWCI_ZRAM_SIZE=$zram_size
ExecStart=/usr/local/sbin/iwci-zram start
ExecStop=/usr/local/sbin/iwci-zram stop

[Install]
WantedBy=multi-user.target
UNIT
  printf '%s\n' '# Written by the iwci install script: swap is compressed RAM (iwci-zram.service).' \
    'vm.swappiness = 150' 'vm.page-cluster = 0' >/etc/sysctl.d/60-iwci-zram.conf
  sysctl -q -p /etc/sysctl.d/60-iwci-zram.conf
  systemctl daemon-reload
  systemctl enable iwci-zram >/dev/null
  # A device already in use keeps its size until the unit is stopped (which
  # swaps everything back in) and started again; the script does not do
  # that under a running server.
  if systemctl start iwci-zram; then
    echo "zram swap: $(awk 'NR > 1 && $1 ~ /^\/dev\/zram/ { printf "%s %d MiB ", $1, $3 / 1024 }' /proc/swaps)"
  else
    echo "warning: zram swap did not start (journalctl -u iwci-zram); the runner runs without it" >&2
  fi
  if awk 'NR > 1 && $1 !~ /^\/dev\/zram/' /proc/swaps | grep -q .; then
    echo "warning: this host also swaps to disk: $(awk 'NR > 1 && $1 !~ /^\/dev\/zram/ { print $1 }' /proc/swaps | tr '\n' ' ')" >&2
    echo "  it is used only once zram is full, but job memory can then reach that disk;" >&2
    echo "  to remove it: swapoff <path>, and take its line out of /etc/fstab" >&2
  fi
elif [[ -f /etc/systemd/system/iwci-zram.service ]]; then
  # No longer asked for: swap back in, and put the kernel's defaults back.
  systemctl disable --now iwci-zram >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/iwci-zram.service /usr/local/sbin/iwci-zram /etc/sysctl.d/60-iwci-zram.conf
  sysctl -q -w vm.swappiness=60 vm.page-cluster=3
  echo "zram swap removed"
fi

# An optional Cloudflare Tunnel, so the runner needs no open port.
if [[ -s /tmp/iwci-tunnel-token ]]; then
  if ! command -v cloudflared >/dev/null; then
    if ! command -v apt-get >/dev/null; then
      echo "error: installing cloudflared needs apt; install it yourself on this host" >&2
      exit 1
    fi
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      >/etc/apt/sources.list.d/cloudflared.list
    apt-get update -q
    apt-get install -y -q cloudflared
  fi
  token="$(cat /tmp/iwci-tunnel-token)"
  if ! systemctl is-enabled --quiet cloudflared 2>/dev/null; then
    cloudflared service install "$token"
  fi
fi
rm -f /tmp/iwci-tunnel-token

systemctl daemon-reload
systemctl enable iwci >/dev/null
if systemctl is-active --quiet iwci; then
  # A restart drains first and can take as long as the longest running job,
  # so do not hold Terraform for it.
  systemctl restart --no-block iwci
  echo "iwci restarting (running jobs finish first)"
else
  systemctl start iwci
  echo "iwci started"
fi
rm -f /tmp/iwci-install.sh
