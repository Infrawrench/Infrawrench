//! A run's secrets for a helper of a split run, sealed to a key only that
//! helper holds, so the store they pass through never holds them.
//!
//! The helper makes an X25519 key for the run ([`Opener`]) and publishes
//! its public half. The runner that has the run seals the secrets to it
//! ([`seal`]) with a key of its own made for that one message: the two
//! agree on a secret, HKDF-SHA256 makes a ChaCha20-Poly1305 key of it, and
//! that key seals the secrets once. Each key is used for one message only,
//! so the nonce is fixed. The private half of the helper's key never
//! leaves its memory and is gone once it has opened what it was sent.
//!
//! What is sent: a version byte, the sender's public key, then the sealed
//! secrets and their tag. The version, both public keys and a label are
//! the associated data, so nothing can be moved between runs or helpers.

use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf::{HKDF_SHA256, Salt};
use ring::rand::SystemRandom;

const VERSION: u8 = 1;
const LABEL: &[u8] = b"iwci split secrets";
/// The length of an X25519 public key.
pub const PUBLIC_KEY_LEN: usize = 32;

/// What a helper keeps to open what it is sent: one message, once.
pub struct Opener {
    private: EphemeralPrivateKey,
    public: Vec<u8>,
}

impl std::fmt::Debug for Opener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Opener").finish_non_exhaustive()
    }
}

impl Opener {
    pub fn new() -> Result<Self, String> {
        let private = EphemeralPrivateKey::generate(&X25519, &SystemRandom::new())
            .map_err(|_| "could not make a key".to_string())?;
        let public = private
            .compute_public_key()
            .map_err(|_| "could not make a key".to_string())?
            .as_ref()
            .to_vec();
        Ok(Self { private, public })
    }

    /// The public half, for the sender.
    pub fn public(&self) -> &[u8] {
        &self.public
    }

    /// Opens what was sealed to this key, which it uses up.
    pub fn open(self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        let bad = || "what was sent does not open".to_string();
        if sealed.len() < 1 + PUBLIC_KEY_LEN + CHACHA20_POLY1305.tag_len() || sealed[0] != VERSION {
            return Err(bad());
        }
        let sender = &sealed[1..1 + PUBLIC_KEY_LEN];
        let key = agreement::agree_ephemeral(
            self.private,
            &UnparsedPublicKey::new(&X25519, sender),
            |shared| message_key(shared, sender, &self.public),
        )
        .map_err(|_| bad())?
        .map_err(|_| bad())?;
        let mut body = sealed[1 + PUBLIC_KEY_LEN..].to_vec();
        let aad = associated(sender, &self.public);
        let plain = key
            .open_in_place(
                Nonce::assume_unique_for_key([0; 12]),
                Aad::from(&aad),
                &mut body,
            )
            .map_err(|_| bad())?;
        Ok(plain.to_vec())
    }
}

/// Seals `plain` to the holder of `recipient`'s private half.
pub fn seal(recipient: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    if recipient.len() != PUBLIC_KEY_LEN {
        return Err("not a public key".into());
    }
    let failed = || "could not seal".to_string();
    let private =
        EphemeralPrivateKey::generate(&X25519, &SystemRandom::new()).map_err(|_| failed())?;
    let sender = private.compute_public_key().map_err(|_| failed())?;
    let sender = sender.as_ref().to_vec();
    let key = agreement::agree_ephemeral(
        private,
        &UnparsedPublicKey::new(&X25519, recipient),
        |shared| message_key(shared, &sender, recipient),
    )
    .map_err(|_| failed())?
    .map_err(|_| failed())?;
    let mut body = plain.to_vec();
    let aad = associated(&sender, recipient);
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key([0; 12]),
        Aad::from(&aad),
        &mut body,
    )
    .map_err(|_| failed())?;
    let mut out = Vec::with_capacity(1 + PUBLIC_KEY_LEN + body.len());
    out.push(VERSION);
    out.extend_from_slice(&sender);
    out.extend_from_slice(&body);
    Ok(out)
}

fn associated(sender: &[u8], recipient: &[u8]) -> Vec<u8> {
    let mut aad = vec![VERSION];
    aad.extend_from_slice(LABEL);
    aad.extend_from_slice(sender);
    aad.extend_from_slice(recipient);
    aad
}

fn message_key(
    shared: &[u8],
    sender: &[u8],
    recipient: &[u8],
) -> Result<LessSafeKey, ring::error::Unspecified> {
    let salt_bytes = associated(sender, recipient);
    let info = [LABEL];
    let prk = Salt::new(HKDF_SHA256, &salt_bytes).extract(shared);
    let okm = prk.expand(&info, &CHACHA20_POLY1305)?;
    Ok(LessSafeKey::new(UnboundKey::from(okm)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_key_it_was_sealed_to_opens_it() {
        let helper = Opener::new().unwrap();
        let sealed = seal(helper.public(), b"{\"TOKEN\":\"t0k3n\"}").unwrap();
        assert!(
            !sealed.windows(5).any(|w| w == b"t0k3n"),
            "nothing in the clear"
        );
        let other = Opener::new().unwrap();
        assert!(other.open(&sealed).is_err());
        assert_eq!(helper.open(&sealed).unwrap(), b"{\"TOKEN\":\"t0k3n\"}");
    }

    #[test]
    fn what_was_changed_or_cut_does_not_open() {
        let helper = Opener::new().unwrap();
        let mut sealed = seal(helper.public(), b"secret").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(helper.open(&sealed).is_err());
        assert!(Opener::new().unwrap().open(&[VERSION]).is_err());
        assert!(seal(b"short", b"x").is_err());
    }

    #[test]
    fn each_seal_is_new() {
        let helper = Opener::new().unwrap();
        assert_ne!(
            seal(helper.public(), b"same").unwrap(),
            seal(helper.public(), b"same").unwrap()
        );
    }
}
