//! A server's life after it starts: draining, stopping without killing
//! jobs, and replacing itself with a newer release.
//!
//! - **Draining** (`POST /v1/drain`, SIGTERM, or an update) stops new runs
//!   from being admitted (`429`, and `draining` in `/v1/capacity`, which
//!   the proxy reads to send work elsewhere) and lets running ones finish.
//! - **SIGTERM / SIGINT** drain, then exit 0, so `systemctl restart` or a
//!   config change never kills a job. The unit's stop timeout has to cover
//!   the longest job (`TimeoutStopSec`, see `deploy/`).
//! - **Updates.** With `--update-channel`, the server reads
//!   `releases/iwci/channels/<channel>.json` from its store every
//!   `--update-every`. A manifest is only believed if it is signed by the
//!   release key (`IWCI_RELEASE_PUBLIC_KEY`): the hosts' own store
//!   credentials can write to the bucket, and an unsigned manifest would let
//!   any one host push a native binary to all of them. When the channel
//!   names another version, the server downloads its binary, checks its
//!   size and sha256, checks that it runs, drains, and `exec`s it with the
//!   same arguments: same process id, same unit, no job killed. The channel
//!   is authoritative, so pointing it at an older version rolls back.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Server;

/// This build's version: the release's, or the crate's for a local build.
pub const VERSION: &str = match option_env!("IWCI_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

/// The platform a release binary is for, as its key names it.
pub fn target() -> String {
    format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
}

pub fn channel_key(channel: &str) -> String {
    format!("releases/iwci/channels/{channel}.json")
}

pub fn binary_key(version: &str, target: &str) -> String {
    format!("releases/iwci/{version}/{target}")
}

/// What a channel points at, as signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub version: String,
    /// Target (`x86_64-linux`) to that target's binary.
    pub targets: BTreeMap<String, ReleaseBinary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseBinary {
    pub sha256: String,
    pub size: u64,
}

/// A channel manifest: the release and the release key's signature over
/// its JSON (`serde_json::to_vec(&release)`, whose field and map order are
/// fixed, so signer and verifier serialise the same bytes).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRelease {
    pub release: Release,
    /// Base64 Ed25519 signature.
    pub signature: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// The signing key from its base64 32-byte seed.
pub fn signing_key(seed_b64: &str) -> Result<SigningKey, String> {
    let seed: [u8; 32] = b64()
        .decode(seed_b64.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the release signing key is 32 bytes, base64")?;
    Ok(SigningKey::from_bytes(&seed))
}

/// The verifying key from its base64 32 bytes.
pub fn verifying_key(b64_key: &str) -> Result<VerifyingKey, String> {
    let bytes: [u8; 32] = b64()
        .decode(b64_key.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("IWCI_RELEASE_PUBLIC_KEY is 32 bytes, base64")?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| format!("IWCI_RELEASE_PUBLIC_KEY: {e}"))
}

pub fn sign(release: Release, key: &SigningKey) -> SignedRelease {
    let bytes = serde_json::to_vec(&release).expect("serialisable");
    SignedRelease {
        signature: b64().encode(key.sign(&bytes).to_bytes()),
        release,
    }
}

/// The release, if `key` signed it.
pub fn verify(signed: &SignedRelease, key: &VerifyingKey) -> Result<Release, String> {
    let signature: [u8; 64] = b64()
        .decode(&signed.signature)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the channel's signature is not 64 bytes of base64")?;
    let bytes = serde_json::to_vec(&signed.release).expect("serialisable");
    key.verify(&bytes, &Signature::from_bytes(&signature))
        .map_err(|_| "the channel is not signed by the release key".to_string())?;
    Ok(signed.release.clone())
}

/// A new key pair: (seed, public key), both base64.
pub fn generate_keypair() -> Result<(String, String), String> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| format!("no randomness: {e}"))?;
    let key = SigningKey::from_bytes(&seed);
    Ok((
        b64().encode(seed),
        b64().encode(key.verifying_key().to_bytes()),
    ))
}

static STOP: AtomicBool = AtomicBool::new(false);

/// How often a server looks at what V8 out-of-memory has cost it.
const V8_LOSSES_EVERY: Duration = Duration::from_secs(5);

/// How long a server that has to restart lets the jobs running then go on
/// before it cancels what is left of its runs (#1135).
const RESTART_GRACE: Duration = Duration::from_secs(10 * 60);

/// Why a server whose V8 has lost `losses` should restart, if it should:
/// any V8 worker thread lost, `restart_after` isolates (`None`: never), or
/// lost isolates holding a quarter of the V8 heap space every Node job
/// shares, `heap_space` bytes (#1063): past that, the jobs' heaps wait on
/// room that never comes back.
fn restart_reason(
    losses: &iwci_runtime::V8Losses,
    restart_after: Option<u64>,
    heap_space: u64,
) -> Option<String> {
    let after = restart_after?;
    if losses.parked_worker_threads != 0 {
        return Some(format!(
            "out-of-memory parked {}, from the pool every job shares",
            count(losses.parked_worker_threads, "V8 worker thread")
        ));
    }
    if heap_space != 0 && losses.lost_heap.saturating_mul(4) >= heap_space {
        return Some(format!(
            "out-of-memory lost {} holding {} MiB of the {} MiB V8 heap space every Node job shares",
            count(losses.lost_isolates, "V8 isolate"),
            losses.lost_heap >> 20,
            heap_space >> 20
        ));
    }
    (losses.lost_isolates >= after).then(|| {
        format!(
            "out-of-memory lost {} (--restart-after-lost-isolates {after})",
            count(losses.lost_isolates, "V8 isolate")
        )
    })
}

/// Waits, polling every `poll`, until `active` is 0, calling `cancel` once
/// when `grace` has passed and it is not.
fn wait_or_cancel(active: impl Fn() -> usize, cancel: impl Fn(), grace: Duration, poll: Duration) {
    let deadline = std::time::Instant::now() + grace;
    let mut cancelled = false;
    while active() > 0 {
        if !cancelled && std::time::Instant::now() >= deadline {
            cancelled = true;
            cancel();
        }
        std::thread::sleep(poll);
    }
}

/// `1 thread`, `2 threads`.
fn count(n: u64, what: &str) -> String {
    if n == 1 {
        format!("1 {what}")
    } else {
        format!("{n} {what}s")
    }
}

impl Server {
    /// Stops admitting runs. Idempotent; the first reason is kept.
    pub(crate) fn begin_drain(&self, reason: &str) {
        if !self.draining.swap(true, Ordering::SeqCst) {
            *self.drain_reason.lock().unwrap() = Some(reason.to_string());
            eprintln!("iwci serve: draining: {reason}");
        }
    }

    fn wait_idle(&self) {
        while self.active.load(Ordering::SeqCst) > 0 {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    /// Drains to restart, which this process needs to work well again
    /// (#1135): no run is admitted, and the runs already active start no
    /// more jobs, reporting those they have not started as cancelled with
    /// `reason` and run-it-again (the job budget is held, see
    /// [`crate::schedule::MemoryBudget::hold`]). The jobs running go on for
    /// `grace`, then whatever is still running is cancelled. Returns once no
    /// run is active. Without this a drain waited for every job of every
    /// active run to have had its turn, each meeting the same lost V8 heaps,
    /// and the restart that ends them waited with it.
    fn drain_to_restart(&self, reason: &str, grace: Duration) {
        self.restarting.store(true, Ordering::SeqCst);
        self.begin_drain(reason);
        if let Some(memory) = &self.runner.memory {
            memory.hold(&format!(
                "the runner is restarting ({reason}); run it again"
            ));
        }
        wait_or_cancel(
            || self.active.load(Ordering::SeqCst),
            || {
                eprintln!(
                    "iwci serve: restarting: cancelling what is left of the runs after {}s",
                    grace.as_secs()
                );
                for control in self.controls.lock().unwrap().values() {
                    control.cancel(None);
                }
            },
            grace,
            Duration::from_secs(1),
        );
    }

    /// SIGTERM and SIGINT drain, then exit 0, instead of killing jobs.
    pub fn stop_gracefully_on_signals(self: &Arc<Self>) -> Result<(), String> {
        for signal in [libc::SIGTERM, libc::SIGINT] {
            // SAFETY: the action only stores to an atomic, which is
            // async-signal-safe.
            unsafe {
                signal_hook_registry::register(signal, || STOP.store(true, Ordering::SeqCst))
            }
            .map_err(|e| format!("installing a signal handler: {e}"))?;
        }
        let server = self.clone();
        std::thread::Builder::new()
            .name("iwci-signals".into())
            .spawn(move || {
                while !STOP.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(200));
                }
                server.begin_drain("stopping");
                server.wait_idle();
                eprintln!("iwci serve: stopped after its runs finished");
                std::process::exit(0);
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Checks `channel` every `every`, and replaces this process with the
    /// release it names when that is not this version.
    pub fn keep_updated(self: &Arc<Self>, channel: String, key: VerifyingKey, every: Duration) {
        let server = self.clone();
        std::thread::Builder::new()
            .name("iwci-update".into())
            .spawn(move || {
                loop {
                    match server.fetch_update(&channel, &key) {
                        Ok(None) => {}
                        Ok(Some((version, path))) => {
                            server.begin_drain(&format!("updating to {version}"));
                            server.wait_idle();
                            match replace_and_exec(&path) {
                                // `exec` only returns on failure.
                                Err(e) => {
                                    eprintln!("iwci serve: the update to {version} failed: {e}; carrying on as {VERSION}");
                                    let _ = std::fs::remove_file(&path);
                                    // Unless it is restarting anyway.
                                    if !server.restarting.load(Ordering::SeqCst) {
                                        server.draining.store(false, Ordering::SeqCst);
                                        *server.drain_reason.lock().unwrap() = None;
                                    }
                                }
                                Ok(never) => match never {},
                            }
                        }
                        Err(e) => eprintln!("iwci serve: checking for updates: {e}"),
                    }
                    std::thread::sleep(every);
                }
            })
            .expect("spawning the update thread");
    }

    /// Watches what V8 running out of memory has cost this process (#990)
    /// and logs it as it grows. Each time the bridge confines one to its job
    /// it parks a thread for good and abandons the isolate, so with
    /// `restart_after` set the server drains and `exec`s itself, as an update
    /// does, once that has cost one of V8's worker threads (the pool every
    /// Node job shares) or `restart_after` isolates.
    pub fn watch_v8_losses(self: &Arc<Self>, restart_after: Option<u64>) {
        let server = self.clone();
        std::thread::Builder::new()
            .name("iwci-v8-losses".into())
            .spawn(move || {
                let mut seen = iwci_runtime::V8Losses::default();
                loop {
                    std::thread::sleep(V8_LOSSES_EVERY);
                    let losses = iwci_runtime::v8_losses();
                    if losses == seen {
                        continue;
                    }
                    seen = losses;
                    eprintln!(
                        "iwci serve: V8 ran out of memory where it cannot recover, kept to its jobs; since this process started that has cost {} and {} parked for good ({} of them V8 worker threads)",
                        count(losses.lost_isolates, "isolate"),
                        count(losses.parked_threads, "thread"),
                        losses.parked_worker_threads
                    );
                    let heap_space = iwci_runtime::v8_heap_space().total;
                    if let Some(reason) = restart_reason(&losses, restart_after, heap_space) {
                        server.drain_to_restart(&reason, RESTART_GRACE);
                        let exe = std::env::current_exe().map_err(|e| e.to_string());
                        eprintln!("iwci serve: restarting: {reason}");
                        let err = match exe.and_then(|exe| exec(&exe)) {
                            Err(e) => e,
                            Ok(never) => match never {},
                        };
                        // Its own binary failed to start: exit instead, and
                        // let the service manager start it again.
                        eprintln!("iwci serve: restarting failed: {err}; exiting");
                        std::process::exit(1);
                    }
                }
            })
            .expect("spawning the V8 watch thread");
    }

    /// The channel's release, downloaded, verified and ready to run, when it
    /// is not this version.
    fn fetch_update(
        &self,
        channel: &str,
        key: &VerifyingKey,
    ) -> Result<Option<(String, PathBuf)>, String> {
        let store = &self.runner.store;
        let Some(bytes) = store
            .get(&channel_key(channel))
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let signed: SignedRelease =
            serde_json::from_slice(&bytes).map_err(|e| format!("channel `{channel}`: {e}"))?;
        let release = verify(&signed, key)?;
        if release.version == VERSION {
            return Ok(None);
        }
        let target = target();
        let Some(binary) = release.targets.get(&target) else {
            return Err(format!(
                "release {} has no build for {target}",
                release.version
            ));
        };
        let bytes = store
            .get(&binary_key(&release.version, &target))
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!(
                    "release {} lists {target} but has no binary",
                    release.version
                )
            })?;
        if bytes.len() as u64 != binary.size || hex::encode(Sha256::digest(&bytes)) != binary.sha256
        {
            return Err(format!(
                "release {}'s binary does not match its signed size and sha256",
                release.version
            ));
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = exe.with_file_name(format!(".iwci-{}.new", release.version));
        write_executable(&path, &bytes)?;
        // A binary that cannot even say its version is not worth draining for.
        let out = std::process::Command::new(&path)
            .arg("version")
            .output()
            .map_err(|e| format!("running the new binary: {e}"))?;
        if !out.status.success() || String::from_utf8_lossy(&out.stdout).trim() != release.version {
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "the new binary does not report version {}",
                release.version
            ));
        }
        Ok(Some((release.version, path)))
    }
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Moves `new` over this executable and becomes it, with the same
/// arguments and environment. Listening sockets close on exec (Rust opens
/// them close-on-exec), and the new process binds again at once.
fn replace_and_exec(new: &Path) -> Result<std::convert::Infallible, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::fs::rename(new, &exe).map_err(|e| format!("replacing {}: {e}", exe.display()))?;
    eprintln!("iwci serve: restarting as the new release");
    exec(&exe)
}

/// Becomes `exe` with this process's arguments and environment.
fn exec(exe: &Path) -> Result<std::convert::Infallible, String> {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec();
    Err(format!("exec {}: {err}", exe.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn a_restart_cancels_runs_still_going_after_its_grace() {
        // Runs that would never end on their own (#1135): cancelled once,
        // when the grace has passed, and then waited for.
        let active = AtomicUsize::new(2);
        let cancels = AtomicUsize::new(0);
        let start = std::time::Instant::now();
        wait_or_cancel(
            || active.load(Ordering::SeqCst),
            || {
                cancels.fetch_add(1, Ordering::SeqCst);
                active.store(0, Ordering::SeqCst);
            },
            Duration::from_millis(50),
            Duration::from_millis(5),
        );
        assert!(start.elapsed() >= Duration::from_millis(50));
        assert_eq!(cancels.load(Ordering::SeqCst), 1);

        // Runs that end within it are never cancelled.
        let active = AtomicUsize::new(1);
        let polls = AtomicUsize::new(0);
        wait_or_cancel(
            || {
                if polls.fetch_add(1, Ordering::SeqCst) == 3 {
                    active.store(0, Ordering::SeqCst);
                }
                active.load(Ordering::SeqCst)
            },
            || panic!("cancelled within the grace"),
            Duration::from_secs(60),
            Duration::from_millis(1),
        );

        // A cancel that takes a while to stop them is not repeated.
        let active = AtomicUsize::new(1);
        let cancels = AtomicUsize::new(0);
        let polls = AtomicUsize::new(0);
        wait_or_cancel(
            || {
                if cancels.load(Ordering::SeqCst) > 0 && polls.fetch_add(1, Ordering::SeqCst) == 5 {
                    active.store(0, Ordering::SeqCst);
                }
                active.load(Ordering::SeqCst)
            },
            || {
                cancels.fetch_add(1, Ordering::SeqCst);
            },
            Duration::ZERO,
            Duration::from_millis(1),
        );
        assert_eq!(cancels.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_server_restarts_for_any_lost_v8_worker_or_enough_lost_isolates() {
        let losses = |lost_isolates, parked_worker_threads| iwci_runtime::V8Losses {
            lost_isolates,
            parked_threads: lost_isolates,
            parked_worker_threads,
            lost_heap: lost_isolates * (100 << 20),
        };
        const SPACE: u64 = 3584 << 20;
        assert_eq!(restart_reason(&losses(0, 0), Some(8), SPACE), None);
        // A job's own thread, parked: one isolate, below the threshold.
        assert_eq!(restart_reason(&losses(7, 0), Some(8), SPACE), None);
        assert_eq!(
            restart_reason(&losses(8, 0), Some(8), SPACE).as_deref(),
            Some("out-of-memory lost 8 V8 isolates (--restart-after-lost-isolates 8)")
        );
        // One of V8's worker threads is gone for every job: at once.
        assert_eq!(
            restart_reason(&losses(1, 1), Some(8), SPACE).as_deref(),
            Some("out-of-memory parked 1 V8 worker thread, from the pool every job shares")
        );
        // Fewer isolates, but holding a quarter of the shared heap (#1063).
        let big = iwci_runtime::V8Losses {
            lost_heap: 900 << 20,
            ..losses(2, 0)
        };
        assert_eq!(
            restart_reason(&big, Some(8), SPACE).as_deref(),
            Some(
                "out-of-memory lost 2 V8 isolates holding 900 MiB of the 3584 MiB V8 heap space every Node job shares"
            )
        );
        // `--restart-after-lost-isolates 0`: never.
        assert_eq!(restart_reason(&losses(100, 3), None, SPACE), None);
        assert_eq!(restart_reason(&big, None, SPACE), None);
    }

    #[test]
    fn a_release_verifies_only_with_its_key_and_unchanged() {
        let (seed, public) = generate_keypair().unwrap();
        let signing = signing_key(&seed).unwrap();
        let verifying = verifying_key(&public).unwrap();
        let release = Release {
            version: "0.2.0".into(),
            targets: BTreeMap::from([(
                "x86_64-linux".to_string(),
                ReleaseBinary {
                    sha256: "ab".repeat(32),
                    size: 10,
                },
            )]),
        };
        let signed = sign(release.clone(), &signing);
        // Through JSON, as the store holds it.
        let back: SignedRelease =
            serde_json::from_slice(&serde_json::to_vec(&signed).unwrap()).unwrap();
        assert_eq!(verify(&back, &verifying).unwrap(), release);

        let mut tampered = back.clone();
        tampered.release.version = "6.6.6".into();
        assert!(verify(&tampered, &verifying).is_err());
        let (_, other) = generate_keypair().unwrap();
        assert!(verify(&back, &verifying_key(&other).unwrap()).is_err());
        assert!(verifying_key("short").is_err());
    }
}
