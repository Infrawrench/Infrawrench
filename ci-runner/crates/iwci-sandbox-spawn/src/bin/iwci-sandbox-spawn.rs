//! The sandbox service (`iwci_sandbox_spawn::service`).

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    iwci_sandbox_spawn::service::main()
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("iwci-sandbox-spawn: Linux only");
    std::process::ExitCode::FAILURE
}
