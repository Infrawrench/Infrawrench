//! QEMU command lines for the two kinds of machine.
//!
//! **Linux** is a micro VM: on x86_64 QEMU's `microvm` machine (no PCI, no
//! firmware, no legacy devices; the shape Firecracker made common), on
//! aarch64 the `virt` machine, which is as small once given only
//! virtio-mmio devices. Both boot the image's kernel directly, with no
//! initramfs, and the agent is PID 1 (`init=`), so a machine answers in
//! well under a second. The disks are read-only erofs images shared by
//! every machine (the image's root, and the workspace's files when the
//! job has a clone); what the job writes goes to a tmpfs inside it.
//!
//! virtio-mmio devices reach the guest in the reverse of the order QEMU is
//! given them (each new transport bus is put at the head of QEMU's list),
//! so the root disk comes last to be `vda`, and the agent finds the
//! workspace disk by its serial (`iwci-ws`) rather than its name.
//!
//! **Windows** is Windows 11 on Arm under the aarch64 `virt` machine with
//! UEFI, on PCI virtio devices (virtio-win's ARM64 drivers), its disk a
//! throwaway qcow2 overlay on the image's. A machine is restored from a
//! state saved just after the image booted when one matches its memory
//! and CPUs (`-incoming`), which takes seconds rather than a boot's
//! minute; restoring needs the same devices the state was saved with, so
//! the network device is always there and a job without a network has
//! its frames dropped instead.
//!
//! No machine has a display, a monitor, a serial port of the host's, or
//! any host file system: the agent's virtio-serial port, the network link
//! and (Linux) the run's `/tmp/workflow` over virtio-fs are its only ways
//! out, all sockets the runner holds. The last is served from the
//! runner's memory (`virtiofs.rs`), never from a directory of the host's;
//! a vhost-user device needs the guest's memory shared with its back end,
//! so a machine that has it gets its memory from a `memfd` QEMU shares.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use iwci_vm_proto::{AGENT_PORT, GUEST_MAC};

/// The serial the workspace disk carries, which the guest looks for.
pub const WORKSPACE_SERIAL: &str = "iwci-ws";

/// The host's architecture, which is the machine's (KVM runs only the
/// host's own).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X86_64,
    Aarch64,
}

impl Arch {
    pub fn host() -> Option<Arch> {
        match std::env::consts::ARCH {
            "x86_64" => Some(Arch::X86_64),
            "aarch64" => Some(Arch::Aarch64),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Arch::X86_64 => "x86_64",
            Arch::Aarch64 => "aarch64",
        }
    }

    /// The emulator's name on `PATH`.
    pub fn qemu(self) -> &'static str {
        match self {
            Arch::X86_64 => "qemu-system-x86_64",
            Arch::Aarch64 => "qemu-system-aarch64",
        }
    }
}

/// The sockets and files of one machine, in a directory of its own.
#[derive(Debug, Clone)]
pub struct Sockets {
    /// The agent's virtio-serial port; the runner listens, QEMU connects.
    pub agent: PathBuf,
    /// The network link, when the machine has one.
    pub net: Option<PathBuf>,
    /// The guest's console (`hvc0` on Linux), for when it does not start.
    pub console: PathBuf,
    /// The run's `/tmp/workflow` as a virtio-fs device (Linux): the
    /// runner listens, QEMU connects.
    pub scratch: Option<PathBuf>,
}

/// A Linux micro VM.
#[derive(Debug, Clone)]
pub struct Linux<'a> {
    pub arch: Arch,
    pub kernel: &'a Path,
    pub rootfs: &'a Path,
    /// The workspace's erofs image, when the job has files.
    pub workspace: Option<&'a Path>,
    pub memory_mib: u64,
    pub cpus: u32,
    pub sockets: &'a Sockets,
}

fn push(args: &mut Vec<OsString>, items: &[&str]) {
    args.extend(items.iter().map(OsString::from));
}

fn path_arg(prefix: &str, path: &Path) -> OsString {
    let mut s = OsString::from(prefix);
    s.push(path.as_os_str());
    s
}

/// The kernel's command line: the agent is init, the root the read-only
/// image, and the network (when there is one) configured by the kernel
/// itself, IPv4 only.
pub fn kernel_cmdline(network: bool) -> String {
    let mut line = String::from(
        "console=hvc0 root=/dev/vda ro rootfstype=erofs init=/usr/local/sbin/iwci-guest reboot=t panic=-1 quiet ipv6.disable=1",
    );
    if network {
        line.push_str(" ip=10.0.2.15::10.0.2.2:255.255.255.0:iwci:eth0:off");
    }
    line
}

fn common(args: &mut Vec<OsString>, memory_mib: u64, cpus: u32) {
    push(
        args,
        &[
            "-enable-kvm",
            "-cpu",
            "host",
            "-nodefaults",
            "-no-user-config",
            "-display",
            "none",
            "-serial",
            "none",
            "-monitor",
            "none",
            "-no-reboot",
        ],
    );
    args.push("-m".into());
    args.push(format!("{memory_mib}M").into());
    args.push("-smp".into());
    args.push(cpus.max(1).to_string().into());
}

fn agent_port(args: &mut Vec<OsString>, sockets: &Sockets, bus: &str) {
    push(args, &["-device", bus]);
    args.push("-chardev".into());
    args.push(path_arg("socket,id=agent,server=off,path=", &sockets.agent));
    args.push("-device".into());
    args.push(format!("virtserialport,chardev=agent,name={AGENT_PORT}").into());
}

fn net(args: &mut Vec<OsString>, path: &Path, device: &str) {
    args.push("-netdev".into());
    args.push(path_arg(
        "stream,id=net0,server=off,addr.type=unix,addr.path=",
        path,
    ));
    let mac = GUEST_MAC.map(|b| format!("{b:02x}")).join(":");
    args.push("-device".into());
    args.push(format!("{device},netdev=net0,mac={mac}").into());
}

/// The arguments for a Linux machine.
pub fn linux_args(m: &Linux<'_>) -> Vec<OsString> {
    let mut args = Vec::new();
    let mut machine = match m.arch {
        Arch::X86_64 => {
            "microvm,acpi=off,x-option-roms=off,pit=off,pic=off,isa-serial=off,rtc=off".to_string()
        }
        Arch::Aarch64 => "virt,gic-version=host".to_string(),
    };
    if m.sockets.scratch.is_some() {
        // A vhost-user device's back end reads and writes the guest's
        // memory itself.
        machine.push_str(",memory-backend=mem");
        args.push("-object".into());
        args.push(
            format!(
                "memory-backend-memfd,id=mem,size={}M,share=on",
                m.memory_mib
            )
            .into(),
        );
    }
    args.push("-M".into());
    args.push(machine.into());
    common(&mut args, m.memory_mib, m.cpus);
    args.push("-kernel".into());
    args.push(m.kernel.into());
    args.push("-append".into());
    args.push(kernel_cmdline(m.sockets.net.is_some()).into());

    // The console and the agent share one virtio-serial device.
    agent_port(&mut args, m.sockets, "virtio-serial-device");
    args.push("-chardev".into());
    args.push(path_arg("file,id=console,path=", &m.sockets.console));
    push(&mut args, &["-device", "virtconsole,chardev=console"]);

    if let Some(path) = &m.sockets.net {
        net(&mut args, path, "virtio-net-device");
    }
    push(&mut args, &["-device", "virtio-rng-device"]);
    if let Some(path) = &m.sockets.scratch {
        args.push("-chardev".into());
        args.push(path_arg("socket,id=scratch,path=", path));
        args.push("-device".into());
        args.push(
            format!(
                "vhost-user-fs-device,chardev=scratch,tag={}",
                iwci_vm_proto::SCRATCH_TAG
            )
            .into(),
        );
    }
    // The workspace first and the root last: see the module's note.
    if let Some(ws) = m.workspace {
        args.push("-drive".into());
        args.push(path_arg("if=none,id=ws,format=raw,readonly=on,file=", ws));
        args.push("-device".into());
        args.push(format!("virtio-blk-device,drive=ws,serial={WORKSPACE_SERIAL}").into());
    }
    args.push("-drive".into());
    args.push(path_arg(
        "if=none,id=root,format=raw,readonly=on,file=",
        m.rootfs,
    ));
    push(&mut args, &["-device", "virtio-blk-device,drive=root"]);
    args
}

/// A Windows on Arm machine.
#[derive(Debug, Clone)]
pub struct Windows<'a> {
    /// The machine type the image's states were saved on.
    pub machine: &'a str,
    /// UEFI's code, read only, shared.
    pub firmware: &'a Path,
    /// This machine's own copy of UEFI's variables.
    pub vars: &'a Path,
    /// This machine's overlay on the image's disk.
    pub disk: &'a Path,
    pub memory_mib: u64,
    pub cpus: u32,
    pub sockets: &'a Sockets,
    /// A saved state to restore rather than boot.
    pub incoming: Option<&'a Path>,
}

/// The arguments for a Windows machine. Its devices are the image's, in
/// the image's order (`ci-runner/images/README.md`): PCI slots are given
/// out in command-line order, and a saved state restores only into the
/// devices it was saved with.
pub fn windows_args(m: &Windows<'_>) -> Vec<OsString> {
    let mut args = Vec::new();
    args.push("-M".into());
    args.push(m.machine.into());
    common(&mut args, m.memory_mib, m.cpus);
    args.push("-drive".into());
    args.push(path_arg(
        "if=pflash,format=raw,readonly=on,file=",
        m.firmware,
    ));
    args.push("-drive".into());
    args.push(path_arg("if=pflash,format=raw,file=", m.vars));
    args.push("-drive".into());
    args.push(path_arg(
        "if=none,id=disk,format=qcow2,cache=unsafe,file=",
        m.disk,
    ));
    let net_path = m
        .sockets
        .net
        .as_deref()
        .expect("a Windows machine always has its network device");
    net(&mut args, net_path, "virtio-net-pci");
    agent_port(&mut args, m.sockets, "virtio-serial-pci");
    push(
        &mut args,
        &[
            "-device",
            "virtio-blk-pci,drive=disk",
            "-device",
            "qemu-xhci",
            "-device",
            "usb-kbd",
            "-device",
            "usb-tablet",
            "-device",
            "ramfb",
            "-device",
            "virtio-rng-pci",
        ],
    );
    if let Some(state) = m.incoming {
        args.push("-incoming".into());
        args.push(path_arg("file:", state));
    }
    args
}

/// The CPU time a process has used, in milliseconds (Linux's `/proc`).
pub fn cpu_ms(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may hold spaces: count
    // fields from after its closing one. utime and stime are the 14th
    // and 15th fields, the 12th and 13th after it.
    let rest = &stat[stat.rfind(')')? + 2..];
    let fields: Vec<&str> = rest.split(' ').collect();
    let ticks: u64 = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
    // Linux's USER_HZ is 100 on every architecture it runs CI on.
    Some(ticks * 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn sockets(net: bool) -> Sockets {
        Sockets {
            agent: "/m/agent.sock".into(),
            net: net.then(|| "/m/net.sock".into()),
            console: "/m/console.log".into(),
            scratch: None,
        }
    }

    #[test]
    fn a_linux_machine_with_the_scratch_over_virtio_fs_shares_its_memory() {
        let s = Sockets {
            scratch: Some("/m/scratch.sock".into()),
            ..sockets(false)
        };
        let args = strings(&linux_args(&Linux {
            arch: Arch::X86_64,
            kernel: Path::new("/img/vmlinux"),
            rootfs: Path::new("/img/rootfs.erofs"),
            workspace: None,
            memory_mib: 1024,
            cpus: 1,
            sockets: &s,
        }));
        let text = args.join(" ");
        for want in [
            "-object memory-backend-memfd,id=mem,size=1024M,share=on",
            ",memory-backend=mem",
            "-m 1024M",
            "socket,id=scratch,path=/m/scratch.sock",
            "vhost-user-fs-device,chardev=scratch,tag=iwci-scratch",
        ] {
            assert!(text.contains(want), "{want} not in {text}");
        }
        assert_eq!(args.last().unwrap(), "virtio-blk-device,drive=root");
        // Without it, the memory is QEMU's own.
        let plain = strings(&linux_args(&Linux {
            arch: Arch::X86_64,
            kernel: Path::new("/img/vmlinux"),
            rootfs: Path::new("/img/rootfs.erofs"),
            workspace: None,
            memory_mib: 1024,
            cpus: 1,
            sockets: &sockets(false),
        }))
        .join(" ");
        assert!(!plain.contains("memfd") && !plain.contains("vhost-user"));
    }

    #[test]
    fn a_linux_micro_vm_on_x86_64() {
        let s = sockets(true);
        let args = strings(&linux_args(&Linux {
            arch: Arch::X86_64,
            kernel: Path::new("/img/vmlinux"),
            rootfs: Path::new("/img/rootfs.erofs"),
            workspace: Some(Path::new("/cache/ws.erofs")),
            memory_mib: 2048,
            cpus: 2,
            sockets: &s,
        }));
        let text = args.join(" ");
        assert!(text.starts_with("-M microvm,acpi=off,"), "{text}");
        for want in [
            "-enable-kvm -cpu host -nodefaults -no-user-config",
            "-m 2048M -smp 2",
            "-kernel /img/vmlinux",
            "socket,id=agent,server=off,path=/m/agent.sock",
            "virtserialport,chardev=agent,name=org.infrawrench.iwci.agent",
            "stream,id=net0,server=off,addr.type=unix,addr.path=/m/net.sock",
            "virtio-net-device,netdev=net0,mac=52:54:00:12:34:56",
            "virtio-blk-device,drive=ws,serial=iwci-ws",
        ] {
            assert!(text.contains(want), "{want} not in {text}");
        }
        let append = &args[args.iter().position(|a| a == "-append").unwrap() + 1];
        assert!(append.contains("init=/usr/local/sbin/iwci-guest"));
        assert!(append.contains("ip=10.0.2.15::10.0.2.2:255.255.255.0:iwci:eth0:off"));
        // The root disk is the last device, so the guest names it vda.
        assert_eq!(args.last().unwrap(), "virtio-blk-device,drive=root");
        assert!(
            text.find("drive=ws").unwrap() < text.find("drive=root").unwrap(),
            "{text}"
        );
    }

    #[test]
    fn a_linux_machine_without_network_or_files() {
        let s = sockets(false);
        let args = strings(&linux_args(&Linux {
            arch: Arch::Aarch64,
            kernel: Path::new("/img/Image"),
            rootfs: Path::new("/img/rootfs.erofs"),
            workspace: None,
            memory_mib: 512,
            cpus: 1,
            sockets: &s,
        }));
        let text = args.join(" ");
        assert!(text.starts_with("-M virt,gic-version=host"));
        assert!(!text.contains("netdev"));
        assert!(!text.contains("ip=10.0.2.15"));
        assert!(!text.contains("iwci-ws"));
    }

    #[test]
    fn a_windows_machine_always_has_its_devices() {
        let s = sockets(true);
        let args = strings(&windows_args(&Windows {
            machine: "virt-8.2,gic-version=host",
            firmware: Path::new("/img/efi-code.fd"),
            vars: Path::new("/m/vars.fd"),
            disk: Path::new("/m/disk.qcow2"),
            memory_mib: 4096,
            cpus: 4,
            sockets: &s,
            incoming: Some(Path::new("/img/state.mig")),
        }));
        let text = args.join(" ");
        // The image's devices, in the image's order.
        let devices: Vec<&str> = args
            .iter()
            .zip(args.iter().skip(1))
            .filter(|(flag, _)| *flag == "-device")
            .map(|(_, d)| d.split(',').next().unwrap())
            .collect();
        assert_eq!(
            devices,
            [
                "virtio-net-pci",
                "virtio-serial-pci",
                "virtserialport",
                "virtio-blk-pci",
                "qemu-xhci",
                "usb-kbd",
                "usb-tablet",
                "ramfb",
                "virtio-rng-pci"
            ]
        );
        for want in [
            "-M virt-8.2,gic-version=host",
            "if=pflash,format=raw,readonly=on,file=/img/efi-code.fd",
            "if=pflash,format=raw,file=/m/vars.fd",
            "virtio-blk-pci,drive=disk",
            "virtio-serial-pci",
            "virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56",
            "-device ramfb",
            "-incoming file:/img/state.mig",
        ] {
            assert!(text.contains(want), "{want} not in {text}");
        }
        assert!(!text.contains("-kernel"));
    }

    #[test]
    fn reads_cpu_time_from_proc_stat() {
        if let Some(ms) = cpu_ms(std::process::id()) {
            assert!(ms < 3_600_000);
        }
    }
}
