//! Native programs for a job, in a gVisor sandbox.
//!
//! A job that runs a native program (Bun) runs whole inside one gVisor
//! sandbox, so that everything in it shares one loopback and one view of
//! the file system. The sandbox has no host file system: its root is the
//! job's own in-memory file system (`iwci_vfs::JobFs`), which the runner
//! serves to gVisor's kernel (the Sentry) over gVisor's file protocol,
//! lisafs ([`lisafs`]). The Sentry is started directly (`runsc boot`,
//! [`runsc`]) with the runner's end of that connection, so no gVisor gofer
//! process, and no host directory, is ever involved.
//!
//! Everything here is Linux only.

#[cfg(target_os = "linux")]
pub mod cgroup;
#[cfg(target_os = "linux")]
pub mod helper;
#[cfg(target_os = "linux")]
pub mod lisafs;
#[cfg(target_os = "linux")]
pub mod net;
#[cfg(target_os = "linux")]
pub mod runsc;
