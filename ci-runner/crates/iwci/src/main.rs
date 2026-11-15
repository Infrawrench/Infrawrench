fn main() -> std::process::ExitCode {
    // Installed as the sandbox helper (`/opt/iwci/lib/iwci-sandbox-spawn`),
    // this binary is only that.
    #[cfg(target_os = "linux")]
    if iwci_runtime::sandbox::helper::invoked() {
        return iwci_runtime::sandbox::helper::main();
    }
    iwci::cli::main()
}
