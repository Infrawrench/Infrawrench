//! Releases of `iwci` itself, which servers started with
//! `--update-channel` install by draining and re-executing
//! (`server_lifecycle.rs`).
//!
//! ```text
//! iwci version
//! iwci release-keygen
//! IWCI_RELEASE_SIGNING_KEY=... iwci release <binary> --version 0.3.0
//!     [--target x86_64-linux] [--channel stable] [--store <dir>] [--cache <dir>]
//! ```
//!
//! A binary is uploaded once per version and target and never replaced.
//! `--channel` then signs a manifest naming it and points the channel at
//! it; publishing another target of the same version adds to that
//! manifest. The signing key comes from the environment only.

use std::process::ExitCode;

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

pub fn release(mut args: Args) -> Result<ExitCode, String> {
    let version = args
        .value("--version")?
        .ok_or("--version <version> is required")?;
    let target = args.value("--target")?.unwrap_or_else(lifecycle::target);
    let channel = args.value("--channel")?;
    for (what, value) in [("version", &version), ("target", &target)] {
        if !is_label(value) {
            return Err(format!(
                "--{what} `{value}` must be letters, digits, `.`, `-` or `_`"
            ));
        }
    }
    if let Some(c) = &channel
        && !is_label(c)
    {
        return Err(format!(
            "--channel `{c}` must be letters, digits, `.`, `-` or `_`"
        ));
    }
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
    let binary = ReleaseBinary {
        sha256: hex::encode(Sha256::digest(&bytes)),
        size: bytes.len() as u64,
    };

    let key = binary_key(&version, &target);
    let created = store
        .put_if_absent(&key, &bytes, "application/octet-stream")
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

    if let (Some(channel), Some(signing)) = (channel, signing) {
        let ckey = channel_key(&channel);
        let mut targets = match store.get(&ckey).map_err(|e| e.to_string())? {
            Some(bytes) => match serde_json::from_slice::<SignedRelease>(&bytes) {
                // Only the same version's other targets carry over; the
                // signature is made again over the whole manifest.
                Ok(old) if old.release.version == version => old.release.targets,
                _ => Default::default(),
            },
            None => Default::default(),
        };
        targets.insert(target.clone(), binary);
        let signed = lifecycle::sign(
            Release {
                version: version.clone(),
                targets,
            },
            &signing,
        );
        store
            .put(
                &ckey,
                &serde_json::to_vec_pretty(&signed).expect("serialisable"),
                "application/json",
            )
            .map_err(|e| e.to_string())?;
        println!(
            "channel `{channel}` now points at {version} ({target} and any targets published before it)"
        );
    }
    Ok(ExitCode::SUCCESS)
}
