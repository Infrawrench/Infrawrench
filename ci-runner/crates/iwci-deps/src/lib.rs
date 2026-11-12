//! Installs a workspace's dependencies into its snapshot: pnpm, Go
//! modules, Cargo crates, Python wheels (pip) and Composer packages.
//!
//! Installation runs on the host, before any job, because it is the only
//! step that needs the network: the isolates that run jobs get none. Each
//! ecosystem reads its lockfile from the snapshot, fetches exactly what the
//! lockfile pins through a [`fetch::Fetcher`] (which verifies every byte
//! against the lockfile's hash and caches by that hash), and lays the result
//! out where that ecosystem's tools look for it. Nothing runs a package
//! manager and nothing executes install scripts.
//!
//! Two caches make the second run fast: the fetcher keeps every download by
//! its hash, and [`cache::LayerCache`] keeps whole installs, keyed by what
//! each one read.

mod archive;
pub mod cache;
pub mod cargo;
pub mod composer;
pub mod fetch;
pub mod go;
pub mod pip;
pub mod pnpm;
