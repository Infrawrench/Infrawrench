//! The `iwci` command. Hand-rolled argument parsing and ANSI output: the
//! runner takes no CLI framework for a handful of subcommands.

mod plan;
mod publish;
mod release;
mod run;
mod serve;
mod store;
pub mod style;

use std::process::ExitCode;

const USAGE: &str = "\
iwci: run CI pipelines in WebAssembly isolates

usage:
  iwci validate <file.yml>... [--json]   check pipeline files
  iwci plan <file.yml> [--json]          print the expanded jobs
  iwci run --repo <url> --sha <sha> --repo-id <id> [options]
                                         run a commit's pipelines
                                         [--cpus <n>] [--memory <size>] limit the runner
                                         (also IWCI_CPUS and IWCI_MEMORY)
                                         [--stall-after 5m] stop a job with no output
                                         and no CPU use for that long; 0 for never
                                         (also IWCI_STALL_AFTER)
                                         [--keep-installs-unpacked 24h] pack a cached
                                         install not used for that long
  iwci serve [--listen <addr>] [options]  run pipelines over HTTP (key: IWCI_SERVER_KEY)
                                         [--jobs-per-cpu 4] [--storage-quota 10GiB]
  iwci publish <dist-dir>...             upload builtins/*/build.sh output
  iwci release <binary> --version <v>    publish iwci itself [--channel stable]
  iwci release-keygen                    a key pair for signing releases
  iwci version                           this build's version
  iwci help                              this text";

pub fn main() -> ExitCode {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let command = argv.remove(0);
    let args = Args(argv);
    let result = match command.as_str() {
        "validate" => plan::validate(args),
        "plan" => plan::plan(args),
        "run" => run::run(args),
        "serve" => serve::serve(args),
        "publish" => publish::publish(args),
        "release" => release::release(args),
        "release-keygen" => release::keygen(args),
        "version" | "--version" => release::version(args),
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!("unknown command `{other}`\n\n{USAGE}")),
    };
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{} {message}", style::fail("error:"));
            ExitCode::from(2)
        }
    }
}

/// The arguments after the subcommand. Flags are taken out as they are
/// read, so whatever is left is the positional arguments.
pub struct Args(Vec<String>);

impl Args {
    pub fn flag(&mut self, name: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|a| a != name);
        self.0.len() != before
    }

    /// `--name value` or `--name=value`.
    pub fn value(&mut self, name: &str) -> Result<Option<String>, String> {
        let prefix = format!("{name}=");
        if let Some(i) = self.0.iter().position(|a| a.starts_with(&prefix)) {
            let arg = self.0.remove(i);
            return Ok(Some(arg[prefix.len()..].to_string()));
        }
        if let Some(i) = self.0.iter().position(|a| a == name) {
            self.0.remove(i);
            if i >= self.0.len() || self.0[i].starts_with("--") {
                return Err(format!("{name} needs a value"));
            }
            return Ok(Some(self.0.remove(i)));
        }
        Ok(None)
    }

    pub fn rest(self) -> Vec<String> {
        self.0
    }
}

/// `--cache <dir>`, else `$IWCI_CACHE_DIR`, else `~/.cache/iwci`: the git
/// repositories, fetched packages, compiled modules and object copies that
/// make the second run of anything fast.
pub fn cache_dir(args: &mut Args) -> Result<std::path::PathBuf, String> {
    if let Some(dir) = args.value("--cache")? {
        return Ok(dir.into());
    }
    if let Some(dir) = std::env::var_os("IWCI_CACHE_DIR") {
        return Ok(dir.into());
    }
    let home = std::env::var_os("HOME").ok_or("set --cache or IWCI_CACHE_DIR (no HOME)")?;
    Ok(std::path::PathBuf::from(home).join(".cache").join("iwci"))
}
