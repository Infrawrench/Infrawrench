//! `iwci-guest`: the agent inside a job's virtual machine.
//!
//! - Linux, as PID 1 or `iwci-guest init`: the machine's init (see
//!   `iwci_guest::init`), which serves the runner over the agent port.
//! - Windows, `iwci-guest serve-port`: serves the runner over the agent
//!   port, conversation after conversation, with the job's paths on the
//!   system drive.
//! - Anywhere, `iwci-guest serve-stdio --root <dir>`: one conversation over
//!   standard input and output, with the job's paths under `<dir>`, for
//!   tests and debugging.

use std::path::PathBuf;
use std::process::ExitCode;

use iwci_guest::{Local, Manifest, Root, serve};

const USAGE: &str = "usage: iwci-guest serve-stdio --root <dir>
       iwci-guest serve-port   (Windows)
       iwci-guest init         (Linux; also when run as PID 1)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(target_os = "linux")]
    if std::process::id() == 1 || args.first().map(String::as_str) == Some("init") {
        iwci_guest::init::run();
    }
    match args.first().map(String::as_str) {
        Some("serve-stdio") => serve_stdio(&args[1..]),
        #[cfg(windows)]
        Some("serve-port") => serve_windows_port(),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn serve_stdio(args: &[String]) -> ExitCode {
    let root = match args {
        [flag, dir] if flag == "--root" => PathBuf::from(dir),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    if !root.is_dir() {
        eprintln!("iwci-guest: {} is not a directory", root.display());
        return ExitCode::from(2);
    }
    let mut tree = Manifest::new(Root::Dir(root));
    match serve(
        std::io::stdin().lock(),
        std::io::stdout(),
        &Local,
        &mut tree,
    ) {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("iwci-guest: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn serve_windows_port() -> ExitCode {
    let port = iwci_guest::port::open_windows();
    let mut tree = Manifest::new(Root::SystemDrive);
    let machine = iwci_guest::platform::WindowsMachine;
    if let Err(e) = iwci_guest::port::serve_port(port, &machine, &mut tree) {
        eprintln!("iwci-guest: {e}");
        return ExitCode::FAILURE;
    }
    // The runner asked for the machine to power off.
    let _ = std::process::Command::new("shutdown.exe")
        .args(["/s", "/t", "0", "/f"])
        .status();
    ExitCode::SUCCESS
}
