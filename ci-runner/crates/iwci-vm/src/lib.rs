//! Jobs in virtual machines: `platform: linux` (a micro VM), started per
//! job with QEMU and KVM on a Linux runner. The Windows 11 on Arm half
//! (`WindowsImage`, `qemu::windows_args`, `windows_env`) is written but
//! turned off: `Host::new` never opens its image, and the parser refuses
//! `platform: windows` (`iwci_spec::VmOs::enabled`).
//!
//! - [`qemu`]: the command lines, and why they look as they do.
//! - [`images`]: the machine images a runner is given, and the workspace
//!   images it makes so a Linux machine starts with the checkout without
//!   copying it.
//! - [`link`]: the machine's network, bridged onto the gateway a gVisor
//!   sandbox's network uses, under the runner's one network policy.
//! - [`agent`]: the conversation with `iwci-guest` ([`iwci_vm_proto`]).
//! - [`archive`]: the job's files as tar archives, with modes.
//! - [`Host`]: one job in one machine, start to finish.
//!
//! The scheduler sees none of this: `iwci`'s `adapters::machines` runs a
//! job through [`Host::run`] and writes what it sent back into the job's
//! files, where artifacts, downloads, caches and `changes:` read them.

pub mod agent;
pub mod archive;
pub mod fuse;
mod host;
pub mod images;
pub mod link;
pub mod qemu;
#[cfg(target_os = "linux")]
pub mod virtiofs;

pub use host::{
    Burst, Collected, Config, Host, Job, Os, Outcome, Scratch, burst_vcpus, windows_env,
};
pub use iwci_vm_proto::Shell;
