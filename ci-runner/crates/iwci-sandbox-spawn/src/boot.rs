//! What starting a sandbox's Sentry takes: a few values, from which its
//! whole command line and descriptor layout follow. The runner and the
//! sandbox service build the command line with the same code, and the
//! service builds it itself from values it checked, never taking one from
//! its caller.

use std::path::{Component, Path, PathBuf};

/// One Sentry to start (`gvisor_sentry boot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Boot {
    /// The container id, `[A-Za-z0-9_.-]`.
    pub id: String,
    /// The sandbox's state directory (`--root` and `--bundle`).
    pub state_dir: PathBuf,
    /// gVisor's platform: `systrap`.
    pub platform: String,
    /// Whether the sandbox gets its network link (`--network=sandbox`) or
    /// only its loopback (`--network=none`).
    pub network: bool,
    /// How many lisafs connections it gets: the root's and one per mount.
    pub mounts: usize,
    /// CPUs and memory it reports to the job.
    pub cpus: u32,
    pub memory: u64,
    /// Extra global flags (`--debug`, `--strace`). Only root may pass any
    /// through the service.
    pub flags: Vec<String>,
}

/// Where each of the Sentry's descriptors is: fixed, from the number of
/// mounts.
///
/// 0 `/dev/null`, 1 and 2 the Sentry's log, 3 the OCI spec, 4 the control
/// socket's listener, then one per lisafs connection, then gVisor's proc
/// unmounter, the log again for the Sentry once it has re-executed itself,
/// and the job's standard input, output and error.
impl Boot {
    pub const SPEC: usize = 3;
    pub const CONTROLLER: usize = 4;
    pub const FIRST_IO: usize = 5;

    pub fn umounter(&self) -> usize {
        Self::FIRST_IO + self.mounts
    }

    fn log(&self) -> usize {
        self.umounter() + 1
    }

    fn stdio(&self) -> [usize; 3] {
        let l = self.log();
        [l + 1, l + 2, l + 3]
    }

    /// How many descriptors the Sentry is given, 0 to this less one.
    pub fn descriptors(&self) -> usize {
        self.stdio()[2] + 1
    }

    /// The Sentry's environment.
    pub fn env() -> Vec<String> {
        vec!["GODEBUG=".into(), "TMPDIR=/tmp".into()]
    }

    /// The Sentry's whole command line.
    pub fn sentry_args(&self, host_memory: u64) -> Vec<String> {
        let log = self.log();
        let io: Vec<String> = (Self::FIRST_IO..self.umounter())
            .map(|fd| fd.to_string())
            .collect();
        let [stdin, stdout, stderr] = self.stdio();
        let mut args: Vec<String> = vec![
            "runsc-sandbox".into(),
            format!("--root={}", self.state_dir.display()),
            format!("--platform={}", self.platform),
            // With a link, the sandbox's stack gets an interface on it
            // (`iwci-sandbox`'s `net`); without one, only its loopback.
            if self.network {
                "--network=sandbox".into()
            } else {
                "--network=none".into()
            },
            "--file-access=exclusive".into(),
            // The other mounts are the runner's too, and nothing else
            // changes them while the sandbox runs; without it the Sentry
            // cannot map their files, so no program could be run from one.
            "--file-access-mounts=exclusive".into(),
            // No host file access at all: directfs would have the Sentry
            // open host files itself, through descriptors a gofer donates.
            "--directfs=false".into(),
            format!("--log-fd={log}"),
            format!("--debug-log-fd={log}"),
            format!("--panic-log-fd={log}"),
        ];
        args.extend(self.flags.iter().cloned());
        args.extend([
            "boot".into(),
            format!("--bundle={}", self.state_dir.display()),
            format!("--spec-fd={}", Self::SPEC),
            format!("--controller-fd={}", Self::CONTROLLER),
            format!("--io-fds={}", io.join(",")),
            format!(
                "--gofer-mount-confs={}",
                vec!["lisafs:none"; self.mounts].join(",")
            ),
            format!("--stdio-fds={stdin},{stdout},{stderr}"),
            // An empty read-only root, and every capability dropped, before
            // anything of the job's runs.
            "--setup-root".into(),
            format!("--proc-umounter-fd={}", self.umounter()),
            format!("--cpu-num={}", self.cpus.max(1)),
            format!("--total-memory={}", self.memory),
            format!("--total-host-memory={host_memory}"),
            "--attached".into(),
            self.id.clone(),
        ]);
        args
    }

    /// The values as the service's request lines, `key=value`.
    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            format!("id={}", self.id),
            format!("root={}", self.state_dir.display()),
            format!("platform={}", self.platform),
            format!("network={}", u8::from(self.network)),
            format!("mounts={}", self.mounts),
            format!("cpus={}", self.cpus),
            format!("memory={}", self.memory),
        ];
        args.extend(self.flags.iter().map(|f| format!("flag={f}")));
        args
    }

    /// The values from the service's request lines, checked; and a Sentry to
    /// use instead of the pinned one (`sentry=`, for root only).
    pub fn from_args(args: &[String]) -> Result<(Self, Option<PathBuf>), String> {
        let mut boot = Boot {
            id: String::new(),
            state_dir: PathBuf::new(),
            platform: String::new(),
            network: false,
            mounts: 0,
            cpus: 0,
            memory: 0,
            flags: Vec::new(),
        };
        let mut sentry = None;
        let mut seen = Vec::new();
        for arg in args {
            let (key, value) = arg
                .split_once('=')
                .ok_or_else(|| format!("{arg:?} is not key=value"))?;
            if key != "flag" {
                if seen.contains(&key) {
                    return Err(format!("{key} given twice"));
                }
                seen.push(key);
            }
            let number = |max: u64| -> Result<u64, String> {
                value
                    .parse::<u64>()
                    .ok()
                    .filter(|n| (1..=max).contains(n))
                    .ok_or_else(|| format!("{key}={value} is out of range"))
            };
            match key {
                "id" => boot.id = value.into(),
                "root" => boot.state_dir = value.into(),
                "platform" => boot.platform = value.into(),
                "network" => {
                    boot.network = match value {
                        "0" => false,
                        "1" => true,
                        _ => return Err(format!("network={value}")),
                    }
                }
                "mounts" => boot.mounts = number(32)? as usize,
                "cpus" => boot.cpus = number(4096)? as u32,
                "memory" => boot.memory = number(1 << 46)?,
                "flag" => boot.flags.push(value.into()),
                "sentry" => sentry = Some(PathBuf::from(value)),
                _ => return Err(format!("unknown {key}")),
            }
        }
        for key in [
            "id", "root", "platform", "network", "mounts", "cpus", "memory",
        ] {
            if !seen.contains(&key) {
                return Err(format!("no {key}"));
            }
        }
        boot.check()?;
        Ok((boot, sentry))
    }

    /// The values are ones the runner would give: a plain id, a plain
    /// absolute state directory, the one platform used.
    pub fn check(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err(format!("id {:?}", self.id));
        }
        if !plain_dir(&self.state_dir) {
            return Err(format!("state directory {:?}", self.state_dir));
        }
        if self.platform != "systrap" {
            return Err(format!("platform {:?}", self.platform));
        }
        Ok(())
    }
}

/// An absolute path of plain names in a safe alphabet, at most 256 bytes.
fn plain_dir(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    path.is_absolute()
        && text.len() <= 256
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.,+=@/-".contains(&b))
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boot() -> Boot {
        Boot {
            id: "iwci-job-1".into(),
            state_dir: "/var/lib/iwci/cache/sandboxes/iwci-job-1".into(),
            platform: "systrap".into(),
            network: true,
            mounts: 3,
            cpus: 4,
            memory: 1 << 30,
            flags: Vec::new(),
        }
    }

    #[test]
    fn the_values_go_through_the_services_request_unchanged() {
        let b = boot();
        assert_eq!(Boot::from_args(&b.to_args()).unwrap(), (b, None));
    }

    #[test]
    fn the_sentry_is_always_started_to_boot_into_an_empty_root() {
        let b = boot();
        let args = b.sentry_args(8 << 30);
        assert_eq!(args[0], "runsc-sandbox");
        let boot = args.iter().position(|a| a == "boot").unwrap();
        assert!(args[boot..].iter().any(|a| a == "--setup-root"));
        assert!(args.iter().any(|a| a == "--directfs=false"));
        assert_eq!(args.last().unwrap(), "iwci-job-1");
        assert!(args.iter().any(|a| a == "--io-fds=5,6,7"));
        assert!(args.iter().any(|a| a == "--proc-umounter-fd=8"));
        assert!(args.iter().any(|a| a == "--stdio-fds=10,11,12"));
        assert_eq!(b.descriptors(), 13);
    }

    #[test]
    fn values_a_runner_would_not_give_are_refused() {
        let with = |extra: &str| {
            let mut args = boot().to_args();
            let key = extra.split('=').next().unwrap();
            args.retain(|a| !a.starts_with(&format!("{key}=")));
            args.push(extra.into());
            Boot::from_args(&args)
        };
        for bad in [
            "id=a b",
            "id=../x",
            "id=",
            "root=relative",
            "root=/a/../b",
            "root=/a/b c",
            "platform=ptrace",
            "network=2",
            "mounts=0",
            "mounts=33",
            "cpus=0",
            "memory=0",
            "what=1",
        ] {
            assert!(with(bad).is_err(), "{bad}");
        }
        let mut twice = boot().to_args();
        twice.push("id=other".into());
        assert!(Boot::from_args(&twice).is_err());
        let mut missing = boot().to_args();
        missing.retain(|a| !a.starts_with("cpus="));
        assert!(Boot::from_args(&missing).is_err());
        // A flag or another Sentry are read, for the service to refuse to
        // anyone but root.
        let (b, sentry) = with("sentry=/tmp/sentry").unwrap();
        assert_eq!(sentry, Some(PathBuf::from("/tmp/sentry")));
        assert!(b.flags.is_empty());
    }
}
