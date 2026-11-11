//! Releases of `iwci` itself, which servers started with
//! `--update-channel` install by draining and re-executing
//! (`server_lifecycle.rs`).
//!
//! ```text
//! iwci version
//! iwci release-keygen
//! IWCI_RELEASE_SIGNING_KEY=... iwci release <binary> --version 0.3.0
//!     [--target x86_64-linux] [--channel stable] [--store <dir>] [--cache <dir>]
//! IWCI_RELEASE_PUBLIC_KEY=... iwci release-status --version 0.3.0
//!     [--target x86_64-linux] [--channel stable] [--store <dir>] [--cache <dir>]
//! ```
//!
//! A binary is uploaded once per version and target and never replaced.
//! `--channel` then signs a manifest naming it and points the channel at
//! it; publishing another target of the same version adds to that
//! manifest, carrying over only targets the release key signed. The signing
//! key comes from the environment only.
//!
//! `release-status` reads without writing: it prints one word saying
//! whether `iwci release` with the same version, target and channel has
//! anything left to do, which is how the release workflow publishes each
//! target on its own and finishes a version that is half published.

use std::process::ExitCode;

use ed25519_dalek::{SigningKey, VerifyingKey};
use iwci_store::{ObjectStore, Version};
use sha2::{Digest, Sha256};

use super::Args;
use crate::server::lifecycle::{
    self, Release, ReleaseBinary, SignedRelease, VERSION, binary_key, channel_key,
};

pub fn version(args: Args) -> Result<ExitCode, String> {
    if !args.rest().is_empty() {
        return Err("`iwci version` takes no arguments".into());
    }
    println!("{VERSION}");
    Ok(ExitCode::SUCCESS)
}

pub fn keygen(args: Args) -> Result<ExitCode, String> {
    if !args.rest().is_empty() {
        return Err("`iwci release-keygen` takes no arguments".into());
    }
    let (seed, public) = lifecycle::generate_keypair()?;
    println!("# Keep this one secret: it is what `iwci release` signs with.");
    println!("IWCI_RELEASE_SIGNING_KEY={seed}");
    println!("# Give this one to every server (`iwci serve --update-channel`).");
    println!("IWCI_RELEASE_PUBLIC_KEY={public}");
    Ok(ExitCode::SUCCESS)
}

fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// `--version`, `--target` and `--channel`, checked.
fn release_args(args: &mut Args) -> Result<(String, String, Option<String>), String> {
    let version = args
        .value("--version")?
        .ok_or("--version <version> is required")?;
    let target = args.value("--target")?.unwrap_or_else(lifecycle::target);
    let channel = args.value("--channel")?;
    for (what, value) in [("version", Some(&version)), ("target", Some(&target))]
        .into_iter()
        .chain([("channel", channel.as_ref())])
    {
        if let Some(value) = value
            && !is_label(value)
        {
            return Err(format!(
                "--{what} `{value}` must be letters, digits, `.`, `-` or `_`"
            ));
        }
    }
    Ok((version, target, channel))
}

pub fn release(mut args: Args) -> Result<ExitCode, String> {
    let (version, target, channel) = release_args(&mut args)?;
    // Read the key before uploading anything, so a missing key fails early.
    let signing = match &channel {
        Some(_) => Some(lifecycle::signing_key(
            &std::env::var("IWCI_RELEASE_SIGNING_KEY")
                .map_err(|_| "set IWCI_RELEASE_SIGNING_KEY to sign the channel")?,
        )?),
        None => None,
    };
    let cache = super::cache_dir(&mut args)?;
    let store = super::store::open(&mut args, &cache)?;
    let rest = args.rest();
    let [path] = rest.as_slice() else {
        return Err("give exactly one binary: `iwci release <binary> --version <v>`".into());
    };
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    publish(
        store.as_ref(),
        &version,
        &target,
        &bytes,
        channel.as_deref().zip(signing.as_ref()),
    )?;
    Ok(ExitCode::SUCCESS)
}

pub fn status(mut args: Args) -> Result<ExitCode, String> {
    let (version, target, channel) = release_args(&mut args)?;
    let verifying = match &channel {
        Some(_) => Some(release_verifying_key()?),
        None => None,
    };
    let cache = super::cache_dir(&mut args)?;
    let store = super::store::open(&mut args, &cache)?;
    if !args.rest().is_empty() {
        return Err("`iwci release-status` takes only flags".into());
    }
    let channel = channel.as_deref().zip(verifying.as_ref());
    let status = target_status(store.as_ref(), &version, &target, channel)?;
    let channel = channel.map_or("", |(c, _)| c);
    // The word on stdout for scripts, the sentence on stderr for people.
    let explanation = match &status {
        Status::Published if channel.is_empty() => format!("{target} {version} is uploaded"),
        Status::Published => format!("channel `{channel}` lists {target} {version}"),
        Status::Uploaded => {
            format!("{target} {version} is uploaded, but channel `{channel}` does not list it")
        }
        Status::Absent => format!("{target} {version} is not uploaded"),
        Status::Superseded(later) => format!(
            "channel `{channel}` is at {later}, later than {version}; publishing {version} would roll it back"
        ),
    };
    eprintln!("{explanation}");
    println!("{}", status.word());
    Ok(ExitCode::SUCCESS)
}

/// The key `release-status` checks the channel's signature with:
/// `IWCI_RELEASE_PUBLIC_KEY`, or the public half of
/// `IWCI_RELEASE_SIGNING_KEY` where only that is set (the release workflow).
fn release_verifying_key() -> Result<VerifyingKey, String> {
    if let Ok(public) = std::env::var("IWCI_RELEASE_PUBLIC_KEY") {
        return lifecycle::verifying_key(&public);
    }
    if let Ok(seed) = std::env::var("IWCI_RELEASE_SIGNING_KEY") {
        return Ok(lifecycle::signing_key(&seed)?.verifying_key());
    }
    Err("set IWCI_RELEASE_PUBLIC_KEY (or IWCI_RELEASE_SIGNING_KEY) to check the channel's signature".into())
}

/// Where one target of one version stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Status {
    /// Uploaded and, with a channel, listed by it under a valid signature
    /// for this version: `iwci release` would change nothing.
    Published,
    /// Uploaded, but the channel does not list it for this version.
    /// `iwci release` adds it if given the same bytes and refuses others.
    Uploaded,
    /// Not uploaded.
    Absent,
    /// The channel is signed for a later version. Publishing this one
    /// would move every host back to it, which only a person should do.
    Superseded(String),
}

impl Status {
    fn word(&self) -> &'static str {
        match self {
            Status::Published => "published",
            Status::Uploaded => "uploaded",
            Status::Absent => "absent",
            Status::Superseded(_) => "superseded",
        }
    }
}

/// A channel manifest as read from the store.
enum Channel {
    Missing,
    /// Present, but not signed by the release key (or not a manifest).
    Unverified,
    Verified(Release),
}

fn read_channel(
    store: &dyn ObjectStore,
    channel: &str,
    key: &VerifyingKey,
) -> Result<Channel, String> {
    let Some(bytes) = store
        .get(&channel_key(channel))
        .map_err(|e| e.to_string())?
    else {
        return Ok(Channel::Missing);
    };
    Ok(
        match serde_json::from_slice::<SignedRelease>(&bytes)
            .ok()
            .and_then(|signed| lifecycle::verify(&signed, key).ok())
        {
            Some(release) => Channel::Verified(release),
            None => Channel::Unverified,
        },
    )
}

/// Whether `a` is a later version than `b`.
fn is_later(a: &str, b: &str) -> Result<bool, String> {
    let parse = |v: &str| v.parse::<Version>().map_err(|e| e.to_string());
    Ok(parse(a)? > parse(b)?)
}

fn target_status(
    store: &dyn ObjectStore,
    version: &str,
    target: &str,
    channel: Option<(&str, &VerifyingKey)>,
) -> Result<Status, String> {
    let uploaded = store
        .head(&binary_key(version, target))
        .map_err(|e| e.to_string())?
        .is_some();
    let Some((channel, key)) = channel else {
        return Ok(if uploaded {
            Status::Published
        } else {
            Status::Absent
        });
    };
    let release = match read_channel(store, channel, key)? {
        Channel::Verified(release) => Some(release),
        Channel::Unverified => {
            eprintln!(
                "warning: channel `{channel}` is not signed by the release key; ignoring what it lists"
            );
            None
        }
        Channel::Missing => None,
    };
    if let Some(release) = &release
        && release.version != version
        && is_later(&release.version, version)?
    {
        return Ok(Status::Superseded(release.version.clone()));
    }
    let listed = release.is_some_and(|r| r.version == version && r.targets.contains_key(target));
    Ok(match (uploaded, listed) {
        (true, true) => Status::Published,
        (true, false) => Status::Uploaded,
        (false, _) => Status::Absent,
    })
}

/// Uploads `bytes` as `version`'s binary for `target`, unless exactly these
/// bytes are already there, and with a channel, signs a manifest for
/// `version` naming it plus the version's other targets the channel already
/// lists under the release key's signature.
fn publish(
    store: &dyn ObjectStore,
    version: &str,
    target: &str,
    bytes: &[u8],
    channel: Option<(&str, &SigningKey)>,
) -> Result<(), String> {
    let binary = ReleaseBinary {
        sha256: hex::encode(Sha256::digest(bytes)),
        size: bytes.len() as u64,
    };

    let key = binary_key(version, target);
    let created = store
        .put_if_absent(&key, bytes, "application/octet-stream")
        .map_err(|e| e.to_string())?;
    if !created {
        let existing = store
            .get(&key)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if hex::encode(Sha256::digest(&existing)) != binary.sha256 {
            return Err(format!(
                "{key} already holds a different binary; a released version never changes, so publish a new version"
            ));
        }
    }
    println!(
        "{} {key} ({} MiB)",
        if created { "uploaded" } else { "already had" },
        binary.size >> 20
    );

    if let Some((channel, signing)) = channel {
        // Only the same version's other targets carry over, and only from a
        // manifest the release key signed: the signature below is made
        // again over the whole manifest, so carrying over an unsigned one
        // would sign whatever a host with store credentials wrote there.
        let mut targets = match read_channel(store, channel, &signing.verifying_key())? {
            Channel::Verified(old) if old.version == version => old.targets,
            Channel::Unverified => {
                eprintln!(
                    "warning: channel `{channel}` is not signed by the release key; replacing it"
                );
                Default::default()
            }
            _ => Default::default(),
        };
        targets.insert(target.to_string(), binary);
        let signed = lifecycle::sign(
            Release {
                version: version.to_string(),
                targets,
            },
            signing,
        );
        store
            .put(
                &channel_key(channel),
                &serde_json::to_vec_pretty(&signed).expect("serialisable"),
                "application/json",
            )
            .map_err(|e| e.to_string())?;
        println!(
            "channel `{channel}` now points at {version} ({target} and any targets published before it)"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use iwci_store::LocalStore;

    use super::*;

    /// A local store in a fresh directory, removed on drop.
    struct TempStore(std::path::PathBuf, LocalStore);

    impl TempStore {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "iwci-release-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let store = LocalStore::new(&dir).unwrap();
            TempStore(dir, store)
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn keys() -> (SigningKey, VerifyingKey) {
        let (seed, _) = lifecycle::generate_keypair().unwrap();
        let signing = lifecycle::signing_key(&seed).unwrap();
        let verifying = signing.verifying_key();
        (signing, verifying)
    }

    const X86: &str = "x86_64-linux";
    const ARM: &str = "aarch64-linux";

    #[test]
    fn each_target_is_published_on_its_own() {
        let store = TempStore::new();
        let s = &store.1;
        let (signing, verifying) = keys();
        let ch = Some(("stable", &verifying));
        let pub_ch = Some(("stable", &signing));

        assert_eq!(target_status(s, "0.3.5", X86, ch).unwrap(), Status::Absent);
        assert_eq!(target_status(s, "0.3.5", ARM, ch).unwrap(), Status::Absent);

        // The x86 half goes out and the ARM64 half never does: the version
        // is half published, and the status says which half is missing.
        publish(s, "0.3.5", X86, b"x86 build", pub_ch).unwrap();
        assert_eq!(
            target_status(s, "0.3.5", X86, ch).unwrap(),
            Status::Published
        );
        assert_eq!(target_status(s, "0.3.5", ARM, ch).unwrap(), Status::Absent);

        // Finishing it adds ARM64 and keeps x86.
        publish(s, "0.3.5", ARM, b"arm build", pub_ch).unwrap();
        for target in [X86, ARM] {
            assert_eq!(
                target_status(s, "0.3.5", target, ch).unwrap(),
                Status::Published
            );
        }
        let Channel::Verified(release) = read_channel(s, "stable", &verifying).unwrap() else {
            panic!("the channel is signed");
        };
        assert_eq!(release.version, "0.3.5");
        assert_eq!(
            release.targets.keys().collect::<Vec<_>>(),
            [&ARM.to_string(), &X86.to_string()]
        );

        // Without a channel, uploaded is all there is to it.
        assert_eq!(
            target_status(s, "0.3.5", ARM, None).unwrap(),
            Status::Published
        );
    }

    #[test]
    fn a_published_target_is_never_replaced() {
        let store = TempStore::new();
        let s = &store.1;
        let (signing, _) = keys();
        publish(s, "0.3.5", X86, b"x86 build", Some(("stable", &signing))).unwrap();
        // The same bytes again are harmless; other bytes are refused.
        publish(s, "0.3.5", X86, b"x86 build", Some(("stable", &signing))).unwrap();
        let err = publish(s, "0.3.5", X86, b"rebuilt", Some(("stable", &signing))).unwrap_err();
        assert!(err.contains("already holds a different binary"), "{err}");
        assert_eq!(
            s.get(&binary_key("0.3.5", X86)).unwrap().unwrap(),
            b"x86 build"
        );
    }

    #[test]
    fn uploaded_but_unlisted_is_not_published() {
        let store = TempStore::new();
        let s = &store.1;
        let (signing, verifying) = keys();
        // A binary that made it to the store before its channel write did.
        publish(s, "0.3.5", ARM, b"arm build", None).unwrap();
        assert_eq!(
            target_status(s, "0.3.5", ARM, Some(("stable", &verifying))).unwrap(),
            Status::Uploaded
        );
        publish(s, "0.3.5", ARM, b"arm build", Some(("stable", &signing))).unwrap();
        assert_eq!(
            target_status(s, "0.3.5", ARM, Some(("stable", &verifying))).unwrap(),
            Status::Published
        );
    }

    #[test]
    fn a_later_channel_is_never_rolled_back_by_a_status_check() {
        let store = TempStore::new();
        let s = &store.1;
        let (signing, verifying) = keys();
        let ch = Some(("stable", &verifying));
        publish(s, "0.3.6", X86, b"new", Some(("stable", &signing))).unwrap();
        assert_eq!(
            target_status(s, "0.3.5", ARM, ch).unwrap(),
            Status::Superseded("0.3.6".into())
        );
        // An earlier channel is just the previous release.
        assert_eq!(target_status(s, "0.3.7", X86, ch).unwrap(), Status::Absent);
        assert_eq!(
            target_status(s, "0.3.6-rc.1", X86, ch).unwrap(),
            Status::Superseded("0.3.6".into())
        );
    }

    #[test]
    fn an_unsigned_channel_lists_nothing_and_is_never_signed_over() {
        let store = TempStore::new();
        let s = &store.1;
        let (signing, verifying) = keys();
        let (other, _) = keys();
        // What a host with store credentials could write: a manifest for
        // the current version naming its own x86 binary.
        let forged = lifecycle::sign(
            Release {
                version: "0.3.5".into(),
                targets: [(
                    X86.to_string(),
                    ReleaseBinary {
                        sha256: "ab".repeat(32),
                        size: 1,
                    },
                )]
                .into(),
            },
            &other,
        );
        s.put(
            &channel_key("stable"),
            &serde_json::to_vec(&forged).unwrap(),
            "application/json",
        )
        .unwrap();
        s.put(
            &binary_key("0.3.5", X86),
            b"planted",
            "application/octet-stream",
        )
        .unwrap();
        let ch = Some(("stable", &verifying));
        assert_eq!(
            target_status(s, "0.3.5", X86, ch).unwrap(),
            Status::Uploaded
        );
        // A later forged version does not block publishing either.
        let mut later = forged.clone();
        later.release.version = "9.9.9".into();
        s.put(
            &channel_key("stable"),
            &serde_json::to_vec(&later).unwrap(),
            "application/json",
        )
        .unwrap();
        assert_eq!(target_status(s, "0.3.5", ARM, ch).unwrap(), Status::Absent);

        // Publishing ARM64 signs a manifest with ARM64 alone, not the
        // forged x86 entry.
        s.put(
            &channel_key("stable"),
            &serde_json::to_vec(&forged).unwrap(),
            "application/json",
        )
        .unwrap();
        publish(s, "0.3.5", ARM, b"arm build", Some(("stable", &signing))).unwrap();
        let Channel::Verified(release) = read_channel(s, "stable", &verifying).unwrap() else {
            panic!("the channel is signed");
        };
        assert_eq!(
            release.targets.keys().collect::<Vec<_>>(),
            [&ARM.to_string()]
        );
    }

    #[test]
    fn release_flags_are_checked() {
        let args = |a: &[&str]| Args(a.iter().map(|s| s.to_string()).collect());
        let (v, t, c) = release_args(&mut args(&[
            "--version",
            "0.3.5",
            "--target",
            ARM,
            "--channel",
            "stable",
        ]))
        .unwrap();
        assert_eq!(
            (v.as_str(), t.as_str(), c.as_deref()),
            ("0.3.5", ARM, Some("stable"))
        );
        assert!(release_args(&mut args(&["--version", "../x"])).is_err());
        assert!(release_args(&mut args(&["--version", "1", "--channel", ".."])).is_err());
        assert!(release_args(&mut args(&[])).is_err());
    }
}
