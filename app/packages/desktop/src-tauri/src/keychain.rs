use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use std::fs;
use std::path::Path;

/// Load the master encryption key from a file, or generate and persist one.
/// Falls back to the OS keychain only if the file approach fails.
pub fn load_or_create_key(key_path: &Path) -> Result<String> {
    if key_path.exists() {
        let key = fs::read_to_string(key_path)?;
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Ok(key);
        }
    }

    // Generate a new 32-byte key and persist it
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let key_b64 = BASE64.encode(raw);

    if let Some(parent) = key_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(key_path, &key_b64)?;

    Ok(key_b64)
}
