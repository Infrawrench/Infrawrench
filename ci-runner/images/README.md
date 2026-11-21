# Machine images

`platform: linux` jobs (and, once turned on, `platform: windows`) run in a QEMU/KVM virtual machine the runner starts for each job, with `iwci-guest` (`crates/iwci-guest`) inside as the agent the runner talks to over a virtio-serial port (`crates/iwci-vm-proto`). This directory builds the two machine images those jobs boot:

| Image            | Platform  | Hosts                            | What it is                                                                                           |
| ---------------- | --------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`   | `linux`   | x86_64 and aarch64               | A kernel and a read-only erofs root file system, booted directly (no firmware, no initramfs)         |
| `windows-11-arm` | `windows` | aarch64 only (Graviton `.metal`) | A golden qcow2 disk, UEFI firmware and variables, and saved machine states restored with `-incoming` |

**Windows is turned off for now.** The parser refuses `platform: windows` and the runner never opens `<vm-dir>/windows`, so building that image does nothing yet; its scripts are kept here for when it has been booted on a real host.

Both aim at what GitHub's hosted runners have for everyday CI ([Ubuntu 24.04](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md), [Windows 11 Arm64](https://github.com/actions/runner-images/blob/main/images/windows/Windows11-VS2026-Arm64-Readme.md)) without the very large items.

**Status:** written and checked statically (shellcheck, xmllint, every kernel config symbol against the pinned kernel's Kconfig, every pinned sum fetched from its publisher), but neither image has been built or booted yet: they were written on a machine without KVM. Expect the first build of each to need fixes.

## Where the runner expects them

```
<vm-dir>/linux/
  vmlinux          x86_64: the uncompressed kernel (the microvm machine boots it through its PVH note)
  Image            aarch64: arch/arm64/boot/Image
  rootfs.erofs     the root file system, lz4hc-compressed erofs, shared read only by every machine
  image.json       {"os","image","arch","version","kernel","kernel_version","kernel_sha256","rootfs_sha256","agent_sha256","snapshot"}
  kernel.config    the kernel's full .config (for reference)
  packages.lock    every package and release in the root, with its version

<vm-dir>/windows/
  disk.qcow2               the golden disk (never written after the build)
  efi-code.fd              edk2 aarch64 code, read only
  efi-vars.fd              the variable store after the install; each machine gets a copy
  state-<m>m-<c>c.mig      a saved machine of <m> MiB and <c> vCPUs, paused just after the agent's hello
  state-<m>m-<c>c.qcow2    that boot's writes, an overlay on disk.qcow2 (see below)
  image.json               versions, sums, the machine type, the device list and the states
```

`build.sh` writes everything to a scratch directory and moves it into `--out` only once the whole image is built, so a failed build leaves the previous image alone.

## `ubuntu-24.04`

### How the runner boots it

- x86_64: `qemu-system-x86_64 -M microvm,acpi=off,x-option-roms=off,pit=off,pic=off,isa-serial=off,rtc=off -enable-kvm -cpu host -nodefaults -no-user-config -kernel vmlinux`
- aarch64: `qemu-system-aarch64 -M virt,gic-version=host -enable-kvm -cpu host -nodefaults -no-user-config -kernel Image`
- `-append "console=hvc0 root=/dev/vda ro rootfstype=erofs init=/usr/local/sbin/iwci-guest reboot=t panic=-1 quiet"`, plus `ip=10.0.2.15::10.0.2.2:255.255.255.0:iwci:eth0:off ipv6.disable=1` when the job has a network.
- virtio-mmio devices only: `virtio-blk-device` for `rootfs.erofs` (read only), `virtio-blk-device` for the job's workspace (read-only erofs, optional, `serial=iwci-ws`), `virtio-net-device` (optional), and `virtio-serial-device` with a `virtconsole` (hvc0) and a `virtserialport,name=org.infrawrench.iwci.agent`.

`root=/dev/vda` relies on the root disk being the **last** `virtio-blk-device` on the command line: virtio-mmio devices are numbered in reverse command-line order. The agent finds the workspace disk by its virtio serial `iwci-ws`, not by its name.

The agent is PID 1. It mounts `/proc`, `/sys` and `/dev`, makes a tmpfs at `/.iwci/rw`, mounts the workspace on `/.iwci/ws`, bind-mounts `/` on `/.iwci/base`, builds an overlay (workspace over base, upper on the tmpfs) at `/.iwci/root` and chroots into it. The image has those four empty directories, the agent at `/usr/local/sbin/iwci-guest`, and `/etc/iwci-image` holding `ubuntu-24.04` (no trailing newline). Jobs run as root with `HOME=/root`; every tool is on the default `PATH` (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`), and `/etc/environment` records the few variables worth setting (`LANG=C.UTF-8`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`). `/etc/resolv.conf` points at the runner's gateway, `10.0.2.2`.

There is no init system, so nothing runs Docker's daemon until a job asks: `iwci-dockerd` mounts the cgroup2 hierarchy if it is missing, puts `/var/lib/docker` and `/var/lib/containerd` on tmpfs (overlay2 cannot put its upper layers on the overlayfs the job's root is), starts `dockerd` and waits until it answers. It does nothing when the daemon is already up.

### The kernel

The newest kernel.org longterm series (6.18, pinned to 6.18.63 and checked against the sum in kernel.org's signed `sha256sums.asc`), `make defconfig` plus [`linux/kernel.config`](linux/kernel.config), merged with `scripts/kconfig/merge_config.sh`. No modules: everything is built in, including virtio over MMIO and PCI, erofs with lz4, overlayfs, tmpfs, ext4, FUSE and virtio-fs (the run's `/tmp/workflow`, served by the runner), cgroup v2 controllers, namespaces, seccomp, BPF, bridge, veth, vxlan, nf_tables with the iptables compatibility layer, `IP_PNP`, kvm-clock and (x86_64) PVH. The build fails if a line of the fragment did not survive `olddefconfig`, so an upstream rename stops the build instead of dropping a feature.

### Building it

On Ubuntu 24.04 of the target architecture, as root, with about 15 GB free and the internet:

```sh
apt-get install debootstrap erofs-utils build-essential bc bison flex libelf-dev libssl-dev curl gnupg xz-utils file
cargo build --release -p iwci-guest --target x86_64-unknown-linux-musl   # or aarch64-unknown-linux-musl
sudo images/linux/build.sh --agent target/x86_64-unknown-linux-musl/release/iwci-guest --out <vm-dir>/linux
```

It installs from the Ubuntu archive as `snapshot.ubuntu.com` had it at the pinned instant (`--snapshot <id>` picks another, `--snapshot none` uses the live archive), so a rebuild gets the same package versions. It cannot cross-build: installers run in a chroot.

## `windows-11-arm`

### How the runner starts it

Restoring a saved state (`-incoming`) only works into a machine with the same QEMU machine type, the same host CPU model, the same memory size, the same vCPU count and the same devices in the same order (PCI slots are handed out in command-line order). The build saves each state with exactly this command line, and the runner must use it too, changing only the paths and the backends:

```sh
qemu-system-aarch64 -nodefaults -no-user-config \
  -M <machine from image.json>,gic-version=host -enable-kvm -cpu host \
  -netdev stream,id=net0,server=off,addr.type=unix,addr.path=<sock> \
  -chardev socket,id=agent,path=<sock>,server=off \
  -smp <cpus> -m <memory_mib>M \
  -drive if=pflash,format=raw,readonly=on,file=efi-code.fd \
  -drive if=pflash,format=raw,file=<copy of efi-vars.fd> \
  -drive if=none,id=disk,format=qcow2,file=<the job's overlay> \
  -device virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56 \
  -device virtio-serial-pci \
  -device virtserialport,chardev=agent,name=org.infrawrench.iwci.agent \
  -device virtio-blk-pci,drive=disk \
  -device qemu-xhci -device usb-kbd -device usb-tablet \
  -device ramfb \
  -device virtio-rng-pci \
  -display none \
  [-incoming file:state-<m>m-<c>c.mig]
```

- `machine` in `image.json` is the versioned type (`virt-8.2`) that `virt` stood for in the QEMU that saved the states: `virt` moves with QEMU upgrades, a saved state does not. `host_cpu` says which CPU it was saved on; a Graviton3 state does not restore on a Graviton4. Build on the instance family the runner uses.
- `devices` in `image.json` is the list above, in order.
- The NIC is always attached, even for a job without a network, because the saved state has it; the runner then gives it a socket that drops every frame. Windows has a static address on it (10.0.2.15/24, gateway and DNS 10.0.2.2, IPv6 unbound), set by MAC.
- `states` lists one entry per saved size: `{"memory_mib", "cpus", "file", "disk", "sha256"}`. The runner restores only when a state matches the job's memory and vCPUs; otherwise it cold-boots `disk.qcow2` (the agent starts at boot either way).
- **A restore runs on that state's overlay, not on `disk.qcow2`.** The saved memory holds Windows' view of the disk after its boot (registry hives, logs, the page file's metadata), so the job's overlay must be created on `state-<m>m-<c>c.qcow2` (`qemu-img create -f qcow2 -b state-4096m-4c.qcow2 -F qcow2 <job>.qcow2`), which is itself an overlay on `disk.qcow2`. Restoring onto a fresh overlay of `disk.qcow2` hands Windows a disk that is missing writes it remembers making, and corrupts it sooner or later. A cold boot uses an overlay on `disk.qcow2` directly.
- The state was saved paused, right after the agent's hello on the port and `--settle-seconds` (90) of idle time, with the host end of the port closed; the agent is waiting for the next connection. The guest clock lags after a restore (KVM on aarch64 adjusts the virtual counter on resume); the agent sets the clock on every start (`HostMsg::Setup`), so nothing in the image does.

Inside the machine, the agent is `C:\iwci\bin\iwci-guest.exe serve-port`, run at every boot by the scheduled task `\iwci\iwci-guest` as the local administrator `runner`, with highest privileges, at normal priority (a task's default is below normal) and no time limit. The task runs `C:\iwci\bin\serve.cmd`, which starts the agent again whenever it exits: a scheduled task's own restart setting covers a failure to start, not an exit. `C:\iwci\image` holds `windows-11-arm` (no trailing newline). The `runner` password is generated per build, used for the install and the task, and not kept anywhere else; nobody logs on interactively.

### What the build does

`build.sh` installs Windows unattended (from [`autounattend.xml`](windows/autounattend.xml), written after [Arm's working scripts](https://github.com/jasonrandrews/win11arm)) with virtio-win 0.1.302's `w11\ARM64` viostor, NetKVM, vioserial and viorng drivers loaded in Windows PE (the [fedorapeople builds](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.302-1/) are attestation-signed; a Red Hat prewhql ARM64 build did not install). [`setup.ps1`](windows/setup.ps1) then runs once at the first logon and:

1. installs the drivers into the running system, and winget at a pinned version (a fresh install registers App Installer only after the Store runs),
2. installs the toolset from [`packages.json`](windows/packages.json) and checks that every tool runs,
3. installs the agent and its scheduled task,
4. turns off what would otherwise run in every job: Windows Update (policy, services, tasks), Defender's real-time, behaviour and script scanning with `C:\` excluded (Tamper Protection, on by default, can revert the real-time switch, and only the Security app or a management service turns it off; the exclusion holds either way), sleep and hibernation, search indexing, SysMain, error reporting, telemetry, automatic maintenance, defragmentation and the diagnostic tasks; and enables long paths, turns off last-access writes and System Restore, and makes the `runner` password never expire (the task logs on with it),
5. cleans up (component store, temp files, event logs, then a retrim so the qcow2 gives freed blocks back), sets the static address, and powers off.

Its progress arrives on the agent's port during the install and `build.sh` prints it. The "Press any key to boot from CD" prompt is answered with Enter over QMP for the first two minutes; Arm's scripts patch `efisys_noprompt.bin` into the ISO instead, which this avoids so the operator's ISO stays as downloaded. Then, for each `--state`, the build boots `disk.qcow2` through a new overlay with the command line above, waits for the agent's hello, settles, pauses the machine and saves it with QMP `migrate` to `state-<m>m-<c>c.mig`.

### Building it

On an aarch64 Ubuntu 24.04 host with KVM (a Graviton `.metal` instance), with about 60 GB free and the internet:

1. Download the Windows 11 ARM64 ISO yourself from <https://www.microsoft.com/software-download/windows11arm64> (links last 24 hours) in English (United States), or pass `--language`, and note the SHA256 the page lists for it.
2. Build the agent: `cargo build --release -p iwci-guest --target aarch64-pc-windows-msvc` (or `-gnullvm`).
3. Run:

```sh
apt-get install qemu-system-arm qemu-utils qemu-efi-aarch64 xorriso libarchive-tools socat python3 openssl curl file
images/windows/build.sh --iso Win11_25H2_English_Arm64.iso --iso-sha256 <from the page> \
  --agent iwci-guest.exe --out <vm-dir>/windows --state 4096x4 --state 8192x4
```

`--edition` picks the edition (`Windows 11 Pro` by default; `Windows 11 Pro N`, `Windows 11 Education`, and `Windows 11 Enterprise` from media that has it). The install takes one to three hours. `--vnc :1 --keep-work` shows the screen and keeps the scratch directory when something goes wrong; `C:\iwci\setup.log` on the disk has setup.ps1's whole log.

## Toolset

| Tool                     | `ubuntu-24.04`                                                                              | `windows-11-arm`                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Git, Git LFS             | 2.43, 3.4.1 (Ubuntu)                                                                        | Git for Windows 2.56.0.4 with LFS 3.8.1 and Git Bash (winget `Git.Git`)         |
| curl, wget               | Ubuntu                                                                                      | curl (Windows), wget 1.21.4 (winget `JernejSimoncic.Wget`)                      |
| jq, yq                   | jq 1.7.1 (Ubuntu), yq 4.54.3 (GitHub release)                                               | jq 1.8.2, yq 4.54.3 (winget)                                                    |
| zip, unzip, 7-Zip        | Ubuntu (`zip`, `unzip`, `7zip`)                                                             | 7-Zip 26.06 (winget), `tar` (Windows)                                           |
| xz, zstd, bzip2          | Ubuntu                                                                                      | 7-Zip reads and writes xz; no zstd (below)                                      |
| C and C++                | build-essential (GCC 13), clang, lld, LLVM 18, autotools (Ubuntu)                           | llvm-mingw 20261020 (LLVM 23.1.4, UCRT; winget `MartinStorsjo.LLVM-MinGW.UCRT`) |
| CMake, Ninja, pkg-config | CMake 3.28, Ninja 1.11, pkg-config (Ubuntu)                                                 | CMake 4.4.4, Ninja 1.13.2 (winget)                                              |
| Python                   | 3.12 with pip and venv (Ubuntu)                                                             | 3.13.17 with pip (winget `Python.Python.3.13`)                                  |
| Node.js, pnpm, yarn      | 24.22.3 LTS (nodejs.org), corepack enabled                                                  | 24.22.3 LTS (nodejs.org MSI), corepack enabled                                  |
| Go                       | 1.27.4 (go.dev)                                                                             | 1.27.4 (winget `GoLang.Go`)                                                     |
| Rust                     | rustup 1.29.3, Rust 1.100.0, minimal profile plus rustfmt and clippy (static.rust-lang.org) | the same, for `aarch64-pc-windows-gnullvm`, linking with llvm-mingw             |
| Java                     | OpenJDK 21 (Ubuntu)                                                                         | Microsoft Build of OpenJDK 21.0.13 (winget), `JAVA_HOME` set                    |
| Ruby                     | 3.2 (Ubuntu `ruby-full`)                                                                    | 4.0.9 (RubyInstaller ARM build, winget)                                         |
| PowerShell               | 7.6.10 LTS (GitHub release)                                                                 | 7.6.10 LTS (GitHub release MSI)                                                 |
| GitHub CLI               | 2.104.0 (GitHub release)                                                                    | 2.104.0 (winget)                                                                |
| kubectl                  | 1.37.2 (dl.k8s.io)                                                                          | 1.37.2 (winget)                                                                 |
| Docker                   | Engine 29.10.0, containerd 2.4.2, buildx 0.39.0, Compose 5.7.1 (Docker's apt repository)    | none (below)                                                                    |
| OpenSSH client           | Ubuntu                                                                                      | Windows                                                                         |
| SQLite                   | 3.45 (Ubuntu)                                                                               | 3.54.1 (winget)                                                                 |

[`linux/packages.txt`](linux/packages.txt) and [`windows/packages.json`](windows/packages.json) are the lists the builds read; this table follows them. Versions are pinned: Ubuntu packages by the archive snapshot, Docker's by exact version, release downloads by version and sha256 (from the publisher's checksum list or release digest), winget packages by exact version (winget checks each installer against the sha256 in its manifest), and Rust toolchains by version (rustup checks each component against the channel manifest). A changed line is a new image version.

### Left out, compared with GitHub's images

- **Large SDKs and toolchains**: the Android SDK and NDK, Visual Studio and the Windows SDK, .NET SDKs, Swift, Haskell (GHC, Cabal, Stack), Julia, Kotlin, PHP, R, Miniconda, Homebrew, MSYS2, vcpkg, extra GCC, Clang and JDK versions, and the tool caches of older Node, Python, Go and Ruby versions. Each is gigabytes, and a job that needs one installs it; the Linux machine's root is a shared read-only erofs image, so its size is paid once per host, but every byte also lengthens builds and the Windows golden disk.
- **Browsers and drivers** (Chrome, Edge's drivers, Firefox, Selenium): large, and updated so often that a pinned copy is stale within weeks.
- **Cloud CLIs** (AWS, Azure, Google Cloud, Alibaba), Terraform, Packer, Pulumi, Helm, Kind, Minikube, Ansible, Bazel: each pins its own version, and the runner's builtins and `tools:` cover the common ones.
- **Gradle, Maven, Ant, sbt**: projects use their wrappers (`./gradlew`, `./mvnw`).
- **Windows without Docker**: there is no Docker Engine for Windows on Arm containers; Linux containers belong in `platform: linux` jobs.
- **Windows without zstd and a standalone xz**: neither publishes a native ARM64 Windows build (winget has x86 and x64 only); 7-Zip handles xz.
- **Windows Rust targets the GNU ABI** (`aarch64-pc-windows-gnullvm`, linked by llvm-mingw): the MSVC target needs Visual Studio's linker and the Windows SDK. A job that needs MSVC installs Visual Studio Build Tools itself.

## Host requirements

- **KVM**: an x86_64 host with VT-x (or AMD-V) for Linux jobs, or an aarch64 host with KVM for either. On AWS, Graviton exposes KVM only on `.metal` instance types (c7g.metal, m7g.metal, c8g.metal-24xl and -48xl, ...); AWS's nested virtualisation is Intel only. Windows jobs need an aarch64 host.
- **QEMU 8.2 or later** (Ubuntu 24.04's): `migrate file:` and `-incoming file:` for the Windows states.
- **erofs-utils 1.7 or later** (Ubuntu 24.04 has 1.7.1) for `mkfs.erofs --tar`.
- **edk2 aarch64 firmware** (`qemu-efi-aarch64`: `/usr/share/AAVMF/AAVMF_CODE.fd` and `AAVMF_VARS.fd`, without Secure Boot keys) for Windows.

## Licensing

The Windows build installs Windows 11 with Microsoft's public KMS client setup key for the chosen edition, which installs it without activating it, and embeds no other key. **The operator brings the licence.** AWS sells no Windows client licences: running Windows 11 on AWS needs your own licence with the rights to run it on dedicated infrastructure such as bare-metal instances (for example Windows Enterprise E3/E5 or VDA E3/E5 per-user subscriptions), activated the way your agreement provides (KMS, Active Directory-based activation, or subscription activation). Check your own agreement; nothing here grants a licence.

Everything else installed is open source or freely redistributable; `packages.lock` (Linux) and `packages.json` (Windows) list what is in each image.
