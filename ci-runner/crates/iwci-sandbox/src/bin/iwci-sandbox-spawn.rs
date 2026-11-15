//! The helper that starts a sandbox's Sentry (`iwci_sandbox::helper`).

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    iwci_sandbox::helper::main()
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("iwci-sandbox-spawn: Linux only");
    std::process::ExitCode::FAILURE
}
