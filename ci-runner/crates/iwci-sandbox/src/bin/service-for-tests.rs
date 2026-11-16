//! The sandbox service (`iwci_sandbox_spawn::service`), for this crate's
//! tests (`tests/gvisor.rs`), which cannot name another package's binary.

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    iwci_sandbox_spawn::service::main()
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    std::process::ExitCode::FAILURE
}
