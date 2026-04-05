use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;

/// Encrypt plaintext with AES-256-GCM.
/// Returns (ciphertext_base64, iv_base64).
pub fn encrypt(plaintext: &str, key: &[u8]) -> Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| anyhow!("Invalid key length: {}", e))?;

    let mut iv_bytes = [0u8; 12]; // 96-bit IV for GCM
    rand::thread_rng().fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| anyhow!("Encryption failed: {}", e))?;

    Ok((BASE64.encode(ciphertext), BASE64.encode(iv_bytes)))
}

/// Decrypt AES-256-GCM ciphertext.
pub fn decrypt(ciphertext_b64: &str, iv_b64: &str, key: &[u8]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| anyhow!("Invalid key length: {}", e))?;

    let ciphertext = BASE64.decode(ciphertext_b64)
        .map_err(|e| anyhow!("Invalid ciphertext base64: {}", e))?;
    let iv_bytes = BASE64.decode(iv_b64)
        .map_err(|e| anyhow!("Invalid IV base64: {}", e))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| anyhow!("Decryption failed: {}", e))?;

    String::from_utf8(plaintext).map_err(|e| anyhow!("Invalid UTF-8 plaintext: {}", e))
}
