#!/usr/bin/env bash
# The windows-11-arm machine image for `platform: windows` jobs: a golden
# qcow2 disk, its UEFI firmware and variables, and saved machine states
# (taken right after boot, with the agent waiting on its port) that the
# runner restores with `-incoming`, so a job's machine starts in seconds
# instead of booting (ci-runner/images/README.md has the contract).
#
#   build.sh --iso <Win11_Arm64.iso> --iso-sha256 <hex> --agent <iwci-guest.exe> --out <vm-dir>/windows [options]
#
#   --iso <path>             the Windows 11 ARM64 ISO the operator downloaded
#                            from https://www.microsoft.com/software-download/windows11arm64
#   --iso-sha256 <hex>       its sha256, as Microsoft publishes it on that page
#   --agent <path>           iwci-guest.exe built for aarch64 Windows
#   --out <dir>              where disk.qcow2, efi-code.fd, efi-vars.fd, the
#                            state files and image.json go
#   --state <MiB>x<cpus>     save a state for machines of this size
#                            (repeatable; default: 4096x4). A state restores
#                            only into a machine of the same memory and vCPUs
#   --edition <name>         the edition to install (default: Windows 11 Pro)
#   --language <tag>         the ISO's language (default: en-US)
#   --install-cpus <n>       vCPUs for the install (default: 4)
#   --install-memory-mib <n> memory for the install (default: 8192)
#   --disk-gb <n>            the disk's virtual size (default: 96)
#   --version <v>            the image version (default: the UTC date and time)
#   --efi-code <path>        edk2 aarch64 code (default: /usr/share/AAVMF/AAVMF_CODE.fd)
#   --efi-vars <path>        its empty variable store (default: /usr/share/AAVMF/AAVMF_VARS.fd)
#   --install-minutes <n>    give up on the install after this long (default: 300)
#   --settle-seconds <n>     idle time between the agent's hello and each save,
#                            so boot-time work is not in every job (default: 90)
#   --vnc <display>          show the screen on VNC (`:1`) instead of nowhere
#   --work <dir>             scratch space, about 60 GB (default: /var/tmp/...)
#   --keep-work              keep the scratch directory (it holds the runner
#                            password, in the unattend ISO)
#
# The steps:
#
#   1. Check the ISO against the given sha256, and fetch virtio-win 0.1.302
#      (checked against the sha256 below): its w11\ARM64 viostor, NetKVM,
#      vioserial and viorng drivers are attestation-signed and install on
#      Windows 11 on Arm.
#   2. An unattend ISO: autounattend.xml with this build's runner password
#      and the edition's public KMS client setup key filled in, setup.ps1,
#      packages.json, the drivers and the agent.
#   3. The unattended install into disk.qcow2, headless: Windows Setup, then
#      setup.ps1 at the first logon, which installs the toolset and powers
#      the machine off. Its progress lines arrive on the agent's
#      virtio-serial port and are printed here. The "Press any key to boot
#      from CD" prompt is answered by pressing Enter over QMP for the first
#      two minutes (Arm's scripts patch efisys_noprompt.bin into the ISO
#      instead; this leaves the operator's ISO alone).
#   4. Per --state: a fresh boot of disk.qcow2 through a new overlay, with
#      the runner's own device list; once the agent sends its hello, the
#      machine is paused and saved with QMP `migrate` to state-<m>m-<c>c.mig.
#      The overlay is kept as state-<m>m-<c>c.qcow2: the saved memory holds
#      Windows' view of the disk after that boot, so a restore must run on
#      top of that overlay, never on disk.qcow2 alone.
#
# Runs on aarch64 Ubuntu 24.04 with KVM (a Graviton .metal instance: AWS
# offers no nested virtualisation on Graviton). A state restores only on
# the same CPU model and QEMU machine type it was saved on, so build on
# the instance family the runner uses. Needs the internet during the
# install (winget and the toolset). Host packages: qemu-system-arm (8.2 or
# later) qemu-utils qemu-efi-aarch64 xorriso libarchive-tools socat
# python3 openssl curl file.
#
# Licensing: this installs Windows 11 with a generic KMS client setup key,
# which does not activate it. Running Windows 11 on AWS bare metal needs a
# licence the operator brings (README.md, "Licensing").
set -euo pipefail

self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

VIRTIO_VERSION=0.1.302
VIRTIO_URL="https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-$VIRTIO_VERSION-1/virtio-win-$VIRTIO_VERSION.iso"
# Computed from that file (the directory publishes only MD5s of its RPMs).
VIRTIO_SHA256=303f7ae40dad495d6ae474fdc571df58958a4dbc5c37a522d80f9a203867949d
DRIVERS=(viostor NetKVM vioserial viorng)

IMAGE=windows-11-arm
# iwci-vm-proto: AGENT_PORT and GUEST_MAC.
AGENT_PORT=org.infrawrench.iwci.agent
GUEST_MAC=52:54:00:12:34:56

# Microsoft's KMS client setup keys
# (https://learn.microsoft.com/windows-server/get-started/kms-client-activation-keys):
# public, they install an edition without activating it.
declare -A SETUP_KEYS=(
  ["Windows 11 Pro"]=W269N-WFGWX-YVC9B-4J6C9-T83GX
  ["Windows 11 Pro N"]=MH37W-N47XK-V7XM9-C7227-GCQG9
  ["Windows 11 Education"]=NW6C2-QMPVW-D7KKK-3GKT6-VCFB2
  ["Windows 11 Enterprise"]=NPPR9-FWDCX-D2C8J-H872K-2YT43
)

die() {
  echo "error: $*" >&2
  exit 1
}

step() {
  echo "==> $*" >&2
}

usage() {
  sed -n '8,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

iso=""
iso_sha256=""
agent=""
out=""
states=()
edition="Windows 11 Pro"
language="en-US"
install_cpus=4
install_memory_mib=8192
disk_gb=96
version="$(date -u +%Y%m%d.%H%M)"
efi_code=/usr/share/AAVMF/AAVMF_CODE.fd
efi_vars_template=/usr/share/AAVMF/AAVMF_VARS.fd
install_minutes=300
settle_seconds=90
vnc=""
work=""
keep_work=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iso) iso="${2:?--iso needs a path}"; shift 2 ;;
    --iso-sha256) iso_sha256="${2:?--iso-sha256 needs a value}"; shift 2 ;;
    --agent) agent="${2:?--agent needs a path}"; shift 2 ;;
    --out) out="${2:?--out needs a directory}"; shift 2 ;;
    --state) states+=("${2:?--state needs <MiB>x<cpus>}"); shift 2 ;;
    --edition) edition="${2:?--edition needs a name}"; shift 2 ;;
    --language) language="${2:?--language needs a tag}"; shift 2 ;;
    --install-cpus) install_cpus="${2:?--install-cpus needs a number}"; shift 2 ;;
    --install-memory-mib) install_memory_mib="${2:?--install-memory-mib needs a number}"; shift 2 ;;
    --disk-gb) disk_gb="${2:?--disk-gb needs a number}"; shift 2 ;;
    --version) version="${2:?--version needs a value}"; shift 2 ;;
    --efi-code) efi_code="${2:?--efi-code needs a path}"; shift 2 ;;
    --efi-vars) efi_vars_template="${2:?--efi-vars needs a path}"; shift 2 ;;
    --install-minutes) install_minutes="${2:?--install-minutes needs a number}"; shift 2 ;;
    --settle-seconds) settle_seconds="${2:?--settle-seconds needs a number}"; shift 2 ;;
    --vnc) vnc="${2:?--vnc needs a display such as :1}"; shift 2 ;;
    --work) work="${2:?--work needs a directory}"; shift 2 ;;
    --keep-work) keep_work=1; shift ;;
    -h | --help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$iso" ]] || die "--iso is required: download the Windows 11 ARM64 ISO from https://www.microsoft.com/software-download/windows11arm64"
[[ -n "$iso_sha256" ]] || die "--iso-sha256 is required: the sha256 Microsoft lists for that ISO on its download page"
[[ -n "$agent" ]] || die "--agent is required (iwci-guest.exe for aarch64 Windows)"
[[ -n "$out" ]] || die "--out is required"
iso_sha256="$(tr '[:upper:]' '[:lower:]' <<<"$iso_sha256")"
[[ "$iso_sha256" =~ ^[0-9a-f]{64}$ ]] || die "--iso-sha256 is not a sha256"
[[ -n "${SETUP_KEYS[$edition]:-}" ]] ||
  die "no setup key for edition '$edition'; one of: $(printf "'%s' " "${!SETUP_KEYS[@]}")"
[[ "$language" =~ ^[a-z]{2,3}-[A-Z]{2}$ ]] || die "--language looks like en-US"
for n in install_cpus install_memory_mib disk_gb install_minutes settle_seconds; do
  [[ "${!n}" =~ ^[0-9]+$ ]] || die "--${n//_/-} must be a number"
done
[[ ${#states[@]} -gt 0 ]] || states=(4096x4)
for s in "${states[@]}"; do
  [[ "$s" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] || die "--state $s: expected <MiB>x<cpus>, such as 4096x4"
done
mapfile -t states < <(printf '%s\n' "${states[@]}" | sort -u -t x -k1,1n -k2,2n)

# --- prerequisites -----------------------------------------------------------

[[ "$(uname -m)" == aarch64 ]] || die "this builds on an aarch64 host (the image is Windows on Arm, run under KVM)"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] ||
  die "no usable /dev/kvm: on AWS, Graviton exposes KVM only on .metal instances (c7g.metal, m7g.metal, c8g.metal-24xl, ...); add yourself to the kvm group"

missing=()
for tool in qemu-system-aarch64 qemu-img xorriso bsdtar socat python3 openssl curl sha256sum file; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[[ ${#missing[@]} -eq 0 ]] || die "missing on this host: ${missing[*]}
  apt-get install qemu-system-arm qemu-utils qemu-efi-aarch64 xorriso libarchive-tools socat python3 openssl curl file"
[[ -r "$efi_code" ]] || die "no edk2 firmware at $efi_code (apt-get install qemu-efi-aarch64, or --efi-code)"
[[ -r "$efi_vars_template" ]] || die "no edk2 variable store at $efi_vars_template (apt-get install qemu-efi-aarch64, or --efi-vars)"

qemu_version="$(qemu-system-aarch64 --version | sed -n 's/^QEMU emulator version \([0-9][0-9.]*\).*/\1/p')"
[[ -n "$qemu_version" ]] || die "cannot tell QEMU's version"
if [[ "$(printf '%s\n8.2\n' "$qemu_version" | sort -V | head -n 1)" != 8.2 ]]; then
  die "QEMU $qemu_version is too old: saving to a file (migrate file:) needs 8.2 or later"
fi
# The versioned machine type `virt` stands for here: a state restores only
# into the same machine type, and `virt` moves on with QEMU upgrades.
machine_type="$(qemu-system-aarch64 -machine help | sed -n 's/^virt .*(alias of \(virt-[0-9.]*\)).*/\1/p' | head -n 1)"
[[ -n "$machine_type" ]] || die "cannot tell which versioned machine type virt is in this QEMU"
host_cpu="$(lscpu 2>/dev/null | sed -n 's/^Model name: *//p' | head -n 1)"

[[ -f "$iso" ]] || die "no ISO at $iso"
[[ -f "$agent" ]] || die "no agent at $agent"
agent_kind="$(file -b "$agent")"
[[ "$agent_kind" == *PE32+* && "$agent_kind" == *Aarch64* ]] ||
  die "$agent is not an aarch64 Windows executable ($agent_kind)"

# --- layout ------------------------------------------------------------------

mkdir -p "$out"
out="$(cd -- "$out" && pwd)"
if [[ -z "$work" ]]; then
  work="$(mktemp -d /var/tmp/iwci-windows-image.XXXXXX)"
else
  mkdir -p "$work"
  work="$(cd -- "$work" && pwd)"
fi
chmod 0700 "$work"
dl="$work/dl"
ua="$work/unattend"
stage="$work/out"
mkdir -p "$dl" "$stage"

background=()
cleanup() {
  local pid
  for pid in "${background[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ $keep_work -eq 0 ]]; then
    rm -rf "$work"
  else
    echo "scratch kept at $work (its unattend ISO holds the runner password)" >&2
  fi
}
trap cleanup EXIT

sha() {
  sha256sum "$1" | cut -d' ' -f1
}

# --- helpers run with python3 -I ---------------------------------------------

# qmp.py <socket> keys <seconds> | save <file>
cat >"$work/qmp.py" <<'EOF'
import json, socket, sys, time

path, mode = sys.argv[1], sys.argv[2]
deadline = time.monotonic() + 60
while True:
    try:
        sock = socket.socket(socket.AF_UNIX)
        sock.connect(path)
        break
    except OSError:
        if time.monotonic() > deadline:
            sys.exit(f"QMP socket {path} never answered")
        time.sleep(0.5)
stream = sock.makefile("rw")


def reply():
    while True:
        line = stream.readline()
        if not line:
            sys.exit("QMP closed the connection")
        message = json.loads(line)
        if "event" not in message:
            return message


def command(name, **arguments):
    request = {"execute": name}
    if arguments:
        request["arguments"] = arguments
    stream.write(json.dumps(request) + "\n")
    stream.flush()
    answer = reply()
    if "error" in answer:
        sys.exit(f"QMP {name}: {answer['error'].get('desc', answer['error'])}")
    return answer.get("return")


reply()  # the greeting
command("qmp_capabilities")
if mode == "keys":
    # Answers "Press any key to boot from CD or DVD" on the first boot.
    end = time.monotonic() + float(sys.argv[3])
    while time.monotonic() < end:
        try:
            command("send-key", keys=[{"type": "qcode", "data": "ret"}])
        except SystemExit:
            break
        time.sleep(1)
elif mode == "save":
    # Paused first: nothing in the guest changes while the state is written.
    command("stop")
    command("migrate", uri="file:" + sys.argv[3])
    while True:
        status = command("query-migrate")
        state = status.get("status")
        if state == "completed":
            break
        if state in ("failed", "cancelled"):
            sys.exit(f"saving the state {state}: {status.get('error-desc', '')}")
        time.sleep(1)
    command("quit")
else:
    sys.exit(f"unknown mode {mode}")
EOF

# hello.py <socket> <seconds>: listens where the agent's chardev connects
# (server=off, as the runner has it), reads the agent's first frame
# (iwci-vm-proto: a kind byte, a little-endian u32 length, then JSON),
# prints the hello and hangs up, which leaves the agent waiting for the
# next connection, the runner's.
cat >"$work/hello.py" <<'EOF'
import json, os, socket, sys, time

path, timeout = sys.argv[1], float(sys.argv[2])
deadline = time.monotonic() + timeout
if os.path.exists(path):
    os.unlink(path)
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen(1)
server.settimeout(60)
try:
    sock, _ = server.accept()
except socket.timeout:
    sys.exit("QEMU never connected to the agent's socket")


def read(n):
    data = b""
    while len(data) < n:
        sock.settimeout(max(1.0, deadline - time.monotonic()))
        try:
            chunk = sock.recv(n - len(data))
        except socket.timeout:
            sys.exit(f"the agent sent no hello within {timeout:.0f} s")
        if not chunk:
            sys.exit("the agent's port closed before its hello")
        data += chunk
    return data


head = read(5)
kind, length = head[0], int.from_bytes(head[1:], "little")
if kind != 1 or length > 1 << 20:
    sys.exit(f"the agent's first frame is kind {kind}, {length} bytes; expected a message")
hello = json.loads(read(length))
if hello.get("op") != "hello":
    sys.exit(f"the agent's first message is {hello!r}, not a hello")
sock.close()
print(json.dumps(hello))
EOF

# The device list the runner starts a Windows machine with, in its order
# (PCI slots are handed out in command-line order, and a state restores
# only into the same devices). image.json records it; README.md has the
# whole command line. Both the install and the saves use it, so Windows
# sees the same NIC (and keeps its static address) in every machine.
devices=(
  -device "virtio-net-pci,netdev=net0,mac=$GUEST_MAC"
  -device "virtio-serial-pci"
  -device "virtserialport,chardev=agent,name=$AGENT_PORT"
  -device "virtio-blk-pci,drive=disk"
  -device "qemu-xhci"
  -device "usb-kbd"
  -device "usb-tablet"
  -device "ramfb"
  -device "virtio-rng-pci"
)
qmp_sock="$work/qmp.sock"
if [[ -n "$vnc" ]]; then display=(-vnc "$vnc"); else display=(-display none); fi

# machine <cpus> <MiB> <efi vars> <disk drive options> <netdev> <agent chardev> [extra...]
machine() {
  local cpus="$1" memory="$2" vars="$3" drive="$4" netdev="$5" chardev="$6"
  shift 6
  rm -f "$qmp_sock"
  qemu-system-aarch64 -nodefaults -no-user-config -name iwci-windows-image \
    -M "$machine_type,gic-version=host" -enable-kvm -cpu host \
    -netdev "$netdev,id=net0" \
    -chardev "$chardev,id=agent" \
    -smp "$cpus" -m "${memory}M" \
    -drive "if=pflash,format=raw,readonly=on,file=$efi_code" \
    -drive "if=pflash,format=raw,file=$vars" \
    -drive "if=none,id=disk,format=qcow2,$drive" \
    "${devices[@]}" \
    "${display[@]}" \
    -qmp "unix:$qmp_sock,server=on,wait=off" \
    "$@"
}

# --- 1. inputs ---------------------------------------------------------------

step "checking $iso"
got="$(sha "$iso")"
[[ "$got" == "$iso_sha256" ]] || die "$iso has sha256 $got, not $iso_sha256"

virtio_iso="$dl/virtio-win-$VIRTIO_VERSION.iso"
if ! { [[ -f "$virtio_iso" ]] && [[ "$(sha "$virtio_iso")" == "$VIRTIO_SHA256" ]]; }; then
  step "virtio-win $VIRTIO_VERSION"
  curl -fsSL --retry 3 --proto '=https' -o "$virtio_iso.part" "$VIRTIO_URL" || die "downloading $VIRTIO_URL failed"
  got="$(sha "$virtio_iso.part")"
  [[ "$got" == "$VIRTIO_SHA256" ]] || die "$VIRTIO_URL has sha256 $got, expected $VIRTIO_SHA256"
  mv "$virtio_iso.part" "$virtio_iso"
fi

# --- 2. unattend ISO ---------------------------------------------------------

step "unattend ISO ($edition, $language)"
rm -rf "$ua"
mkdir -p "$ua/drivers" "$ua/iwci"
for driver in "${DRIVERS[@]}"; do
  mkdir -p "$ua/drivers/$driver"
  bsdtar -xf "$virtio_iso" -C "$ua/drivers/$driver" --strip-components=3 "$driver/w11/ARM64"
  compgen -G "$ua/drivers/$driver/*.inf" >/dev/null ||
    die "virtio-win $VIRTIO_VERSION has no $driver/w11/ARM64 driver"
done

password="Iw1-$(openssl rand -hex 16)"
(umask 077 && printf '%s' "$password" >"$ua/iwci/runner-password")
printf '%s' "$IMAGE" >"$ua/iwci/image"
cp "$agent" "$ua/iwci/iwci-guest.exe"
cp "$self/setup.ps1" "$self/packages.json" "$ua/"
printf 'iwci unattend media\r\n' >"$ua/iwci-unattend.tag"

drivers_csv="$(IFS=,; echo "${DRIVERS[*]}")"
IWCI_PASSWORD="$password" python3 -I - "$self/autounattend.xml" "$ua/autounattend.xml" \
  "$language" "$edition" "${SETUP_KEYS[$edition]}" "$drivers_csv" <<'EOF'
import os, re, sys
from xml.sax.saxutils import escape

source, target, language, edition, key, drivers = sys.argv[1:7]
text = open(source, encoding="utf-8").read()
# The leading comment documents the placeholders; it does not ship.
text = re.sub(r"<!--.*?-->\n", "", text, count=1, flags=re.S)
# One path per driver and drive letter: the unattend ISO's letter in
# Windows PE depends on the order the firmware finds the media.
paths, n = [], 0
for letter in "DEFGHIJK":
    for driver in drivers.split(","):
        n += 1
        paths.append(
            f'<PathAndCredentials wcm:action="add" wcm:keyValue="{n}">'
            f"<Path>{letter}:\\drivers\\{driver}</Path></PathAndCredentials>"
        )
text = text.replace("<!-- @DRIVER_PATHS@ -->", "\n        ".join(paths))
for name, value in {
    "LANGUAGE": language,
    "IMAGE_NAME": edition,
    "PRODUCT_KEY": key,
    "RUNNER_PASSWORD": os.environ["IWCI_PASSWORD"],
}.items():
    text = text.replace(f"@{name}@", escape(value))
left = re.findall(r"@[A-Z_]+@", text)
if left:
    sys.exit(f"autounattend.xml: unfilled placeholders {left}")
with open(target, "w", encoding="utf-8") as f:
    f.write(text)
EOF

xorriso -as mkisofs -quiet -J -joliet-long -r -V IWCI_UNATTEND -o "$work/unattend.iso" "$ua"

# --- 3. install --------------------------------------------------------------

step "installing Windows ($install_cpus vCPUs, $install_memory_mib MiB, ${disk_gb} GB disk; up to $install_minutes minutes)"
efi_vars="$stage/efi-vars.fd"
disk="$stage/disk.qcow2"
cp "$efi_vars_template" "$efi_vars"
rm -f "$disk"
qemu-img create -q -f qcow2 "$disk" "${disk_gb}G"
install_log="$work/install.log"
: >"$install_log"

# QEMU's user-mode network for the downloads (it gives the guest 10.0.2.15
# behind 10.0.2.2 by DHCP, the same addresses setup.ps1 sets statically at
# the end). The ISOs are USB CD-ROMs on the xHCI controller, as in Arm's
# scripts; USB devices take no PCI slot, so the device list stays the
# runner's.
machine "$install_cpus" "$install_memory_mib" "$efi_vars" \
  "file=$disk,discard=unmap,cache=unsafe" user "file,path=$install_log,append=on" \
  -drive "if=none,id=installer,media=cdrom,readonly=on,file=$iso" \
  -device "usb-storage,drive=installer" \
  -drive "if=none,id=unattend,media=cdrom,readonly=on,file=$work/unattend.iso" \
  -device "usb-storage,drive=unattend" \
  >"$work/qemu-install.log" 2>&1 &
qemu_pid=$!
background+=("$qemu_pid")
python3 -I "$work/qmp.py" "$qmp_sock" keys 120 >/dev/null 2>&1 &
background+=("$!")

started=$SECONDS
shown=0
while kill -0 "$qemu_pid" 2>/dev/null; do
  sleep 15
  lines="$(wc -l <"$install_log")"
  if ((lines > shown)); then
    sed -n "$((shown + 1)),${lines}p" "$install_log" >&2
    shown=$lines
  fi
  elapsed=$(((SECONDS - started) / 60))
  if ((elapsed >= install_minutes)); then
    die "the install has not finished after $install_minutes minutes (to watch the screen: --vnc :1 --keep-work)"
  fi
  if (((SECONDS - started) % 600 < 15)); then
    echo "    ${elapsed} min, disk $(du -h "$disk" | cut -f1)" >&2
  fi
done
qemu_status=0
wait "$qemu_pid" || qemu_status=$?
sed -n "$((shown + 1)),\$p" "$install_log" >&2
[[ $qemu_status -eq 0 ]] || die "QEMU exited with $qemu_status during the install: $(tail -n 5 "$work/qemu-install.log")"
if grep -q '^iwci-setup: failed' "$install_log"; then
  die "setup.ps1 $(grep '^iwci-setup: failed' "$install_log" | tail -n 1 | cut -d' ' -f2-)"
fi
grep -qx 'iwci-setup: done' "$install_log" ||
  die "the machine powered off without setup.ps1 saying it was done (its log is C:\\iwci\\setup.log on $disk; rerun with --keep-work)"
chmod a-w "$disk" "$efi_vars"

# --- 4. saved states ---------------------------------------------------------

# Like the runner's network for a job without one: a stream socket that
# swallows every frame.
net_sock="$work/net.sock"
rm -f "$net_sock"
socat -u "UNIX-LISTEN:$net_sock,fork" OPEN:/dev/null &
background+=("$!")
for _ in $(seq 50); do
  [[ -S "$net_sock" ]] && break
  sleep 0.1
done
[[ -S "$net_sock" ]] || die "socat did not open $net_sock"

agent_sock="$work/agent.sock"
state_entries=()
for state in "${states[@]}"; do
  memory="${state%x*}"
  cpus="${state#*x}"
  name="state-${memory}m-${cpus}c"
  step "$name: booting disk.qcow2 ($memory MiB, $cpus vCPUs) and waiting for the agent"

  overlay="$stage/$name.qcow2"
  rm -f "$overlay"
  # Backing file named relative to the overlay, so the pair moves together.
  (cd "$stage" && qemu-img create -q -f qcow2 -b disk.qcow2 -F qcow2 "$name.qcow2")
  vars="$work/$name-vars.fd"
  cp "$efi_vars" "$vars"
  chmod u+w "$vars"

  python3 -I "$work/hello.py" "$agent_sock" 900 >"$work/$name-hello.json" &
  hello_pid=$!
  background+=("$hello_pid")
  for _ in $(seq 50); do
    [[ -S "$agent_sock" ]] && break
    sleep 0.1
  done
  [[ -S "$agent_sock" ]] || die "the agent's socket did not open"

  machine "$cpus" "$memory" "$vars" "file=$overlay,discard=unmap" \
    "stream,server=off,addr.type=unix,addr.path=$net_sock" \
    "socket,path=$agent_sock,server=off" \
    >"$work/qemu-$name.log" 2>&1 &
  qemu_pid=$!
  background+=("$qemu_pid")

  wait "$hello_pid" || die "$name: the agent did not answer on its port ($(tail -n 3 "$work/qemu-$name.log"))"
  hello="$(cat "$work/$name-hello.json")"
  echo "    $hello" >&2
  python3 -I - "$hello" "$IMAGE" <<'EOF' || die "the agent's hello does not match this image"
import json, sys
hello, image = json.loads(sys.argv[1]), sys.argv[2]
if hello.get("os") != "windows" or hello.get("image") != image:
    sys.exit(f"hello says os={hello.get('os')!r} image={hello.get('image')!r}")
EOF

  step "$name: settling for $settle_seconds s, then saving"
  sleep "$settle_seconds"
  python3 -I "$work/qmp.py" "$qmp_sock" save "$stage/$name.mig" || die "$name: saving the machine state failed"
  wait "$qemu_pid" || true
  state_entries+=("$memory $cpus $name")
done

cp "$efi_code" "$stage/efi-code.fd"

step "image.json"
printf '%s\n' "${devices[@]}" | grep -v '^-device$' >"$work/devices.txt"
printf '%s\n' "${state_entries[@]}" >"$work/states.txt"
python3 -I - "$stage" "$work/devices.txt" "$work/states.txt" "$hello" <<EOF
import hashlib, json, os, sys

stage, devices_file, states_file, hello = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])


def sha(name):
    digest = hashlib.sha256()
    with open(os.path.join(stage, name), "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


states = []
for line in open(states_file).read().split("\n"):
    if not line:
        continue
    memory, cpus, name = line.split()
    states.append({
        "memory_mib": int(memory),
        "cpus": int(cpus),
        "file": name + ".mig",
        "disk": name + ".qcow2",
        "sha256": sha(name + ".mig"),
    })
image = {
    "os": "windows",
    "image": "$IMAGE",
    "arch": "aarch64",
    "version": "$version",
    "edition": "$edition",
    "windows_iso_sha256": "$iso_sha256",
    "virtio_win": "$VIRTIO_VERSION",
    "agent_sha256": "$(sha "$agent")",
    "agent_version": hello.get("agent", ""),
    "protocol": hello.get("protocol"),
    "disk_sha256": sha("disk.qcow2"),
    "efi_code_sha256": sha("efi-code.fd"),
    "efi_vars_sha256": sha("efi-vars.fd"),
    "qemu_version": "$qemu_version",
    "machine": "$machine_type,gic-version=host",
    "host_cpu": "$host_cpu",
    "devices": [d for d in open(devices_file).read().split("\n") if d],
    "states": states,
}
with open(os.path.join(stage, "image.json"), "w") as f:
    json.dump(image, f, indent=2)
    f.write("\n")
EOF

# Replace the old image only once the new one is whole (stale states of
# sizes no longer built go too).
rm -f "$out"/state-*.mig "$out"/state-*.qcow2
for f in "$stage"/*; do
  mv -f "$f" "$out/"
done
step "done: $out ($IMAGE $version; states: ${states[*]})"
