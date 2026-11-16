//! Starting a gVisor sandbox's Sentry in new user, mount, PID, IPC, UTS and
//! network namespaces ([`spawn`]), from a few checked values ([`boot`]):
//! by the runner itself or, where it may not make user namespaces, by the
//! sandbox service ([`service`], with its runner's end in [`client`]),
//! which this crate also builds.
//!
//! Linux only.

#[cfg(target_os = "linux")]
pub mod boot;
#[cfg(target_os = "linux")]
pub mod client;
#[cfg(target_os = "linux")]
pub mod service;
#[cfg(target_os = "linux")]
pub mod spawn;
#[cfg(target_os = "linux")]
pub mod wire;
