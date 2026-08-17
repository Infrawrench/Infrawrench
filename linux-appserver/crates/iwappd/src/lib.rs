//! The Infrawrench remote application server.
//!
//! Split lib/bin on purpose: everything of substance — the protocol state
//! machine, flow control, the launcher, the environment applications are
//! spawned into — is library code with a narrow [`backend::Backend`] seam, and
//! the binary is a thin main that wires it to stdio. The compositor
//! implementation behind that seam is Linux-only; everything above it builds
//! and tests anywhere.

pub mod args;
pub mod backend;
pub mod catalog;
pub mod keymap;
pub mod launch_env;
pub mod paint;
pub mod png;
pub mod session;

/// The compositor and the two modes that drive it. Linux-only: everything
/// above the `Backend` seam builds anywhere, this does not.
#[cfg(target_os = "linux")]
pub mod capture;
#[cfg(target_os = "linux")]
pub mod compositor;
#[cfg(target_os = "linux")]
pub mod serve;

#[cfg(test)]
mod testing;

/// Version of this binary, reported in the protocol handshake and used by the
/// client to decide whether the copy cached on a host is current.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
