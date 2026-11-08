//! Opening the object store from flags and the environment.
//!
//! `--store <dir>` uses a local directory laid out exactly like the bucket,
//! for development and tests. Otherwise R2, from `IWCI_R2_ACCOUNT_ID`,
//! `IWCI_R2_BUCKET`, `IWCI_R2_ACCESS_KEY_ID` and `IWCI_R2_SECRET_ACCESS_KEY`
//! (an R2 API token's S3 credentials). Credentials come from the
//! environment only, never flags, so they stay out of shell history and
//! process listings.

use std::path::Path;
use std::sync::Arc;

use iwci_store::{Credentials, LayeredStore, LocalStore, ObjectStore, R2Store};

use super::Args;

pub fn open(args: &mut Args, cache_dir: &Path) -> Result<Arc<dyn ObjectStore>, String> {
    if let Some(dir) = args.value("--store")? {
        let store = LocalStore::new(&dir).map_err(|e| format!("--store {dir}: {e}"))?;
        return Ok(Arc::new(store));
    }
    let var = |name: &str| {
        std::env::var(name)
            .map_err(|_| format!("set {name}, or pass --store <dir> for a local store"))
    };
    let account = var("IWCI_R2_ACCOUNT_ID")?;
    let bucket = var("IWCI_R2_BUCKET")?;
    let credentials = Credentials::new(
        var("IWCI_R2_ACCESS_KEY_ID")?,
        var("IWCI_R2_SECRET_ACCESS_KEY")?,
    );
    let remote = R2Store::new(&account, &bucket, credentials).map_err(|e| e.to_string())?;
    // Blobs are immutable by hash, so a disk copy in front of R2 is always
    // safe and saves re-downloading the same compiler for every run.
    let cache = LocalStore::new(cache_dir.join("objects")).map_err(|e| e.to_string())?;
    Ok(Arc::new(LayeredStore::new(cache, remote)))
}
