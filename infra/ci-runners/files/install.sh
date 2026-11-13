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
