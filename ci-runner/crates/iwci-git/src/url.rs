//! Remote URLs: the form that keys the cache and the form handed to gix.

use gix::bstr::ByteSlice;
use sha2::{Digest, Sha256};

use crate::{Auth, GitError, Result};

/// A parsed remote. `fetch_url` carries no credentials, so nothing that
/// prints it (gix errors, logs) can leak a token that came in the URL.
#[derive(Debug, Clone)]
pub(crate) struct Remote {
    /// The URL gix connects to, credentials removed.
    pub fetch_url: gix::Url,
    /// Scheme, lowercased host, port and path without a trailing `/` or
    /// `.git`. Two spellings of one repository share one cache.
    pub normalised: String,
    /// hex(sha256(normalised)), the directory name in the cache.
    pub key: String,
    /// A password that came in the URL, used when no explicit auth is given.
    pub url_auth: Option<Auth>,
}

pub(crate) fn parse(input: &str) -> Result<Remote> {
    let bad = |why: &str| GitError::BadUrl(format!("{}: {why}", redact(input)));
    let mut url = gix::url::parse(input.as_bytes().as_bstr()).map_err(|_| bad("unparsable"))?;

    let url_auth = match (url.user(), url.password()) {
        (Some(user), Some(password)) if !password.is_empty() => Some(Auth::basic(user, password)),
        _ => None,
    };
    let scheme = url.scheme.as_str().to_ascii_lowercase();
    // A user name over SSH selects the account on the server (`git@`), so
    // it stays in the URL gix dials; over HTTP it is only ever a credential.
    let keep_user = matches!(url.scheme, gix::url::Scheme::Ssh);
    url.set_password(None);
    if !keep_user {
        url.set_user(None);
    }
    if let Some(host) = url.host.as_mut() {
        *host = host.to_ascii_lowercase();
    }

    let path = url.path.to_str().map_err(|_| bad("path is not UTF-8"))?;
    let mut trimmed = path.trim_end_matches('/');
    trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(bad("no repository path"));
    }
    let host = url.host().unwrap_or("");
    let port = match url.port {
        Some(port) if Some(port) != default_port(&url.scheme) => format!(":{port}"),
        _ => String::new(),
    };
    let slash = if trimmed.starts_with('/') { "" } else { "/" };
    let normalised = format!("{scheme}://{host}{port}{slash}{trimmed}");
    let key = hex::encode(Sha256::digest(normalised.as_bytes()));
    Ok(Remote {
        fetch_url: url,
        normalised,
        key,
        url_auth,
    })
}

fn default_port(scheme: &gix::url::Scheme) -> Option<u16> {
    match scheme {
        gix::url::Scheme::Https => Some(443),
        gix::url::Scheme::Http => Some(80),
        gix::url::Scheme::Ssh => Some(22),
        gix::url::Scheme::Git => Some(9418),
        _ => None,
    }
}

/// `input` with anything between `://` and `@` replaced, for error
/// messages about URLs that failed to parse.
fn redact(input: &str) -> String {
    match (input.find("://"), input.rfind('@')) {
        (Some(start), Some(at)) if at > start => {
            format!("{}://***@{}", &input[..start], &input[at + 1..])
        }
        _ => input.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spellings_of_one_repository_share_a_key() {
        let a = parse("https://GitHub.com/Org/Repo.git").unwrap();
        let b = parse("https://x-access-token:secret@github.com/Org/Repo/").unwrap();
        let c = parse("https://github.com:443/Org/Repo").unwrap();
        assert_eq!(a.normalised, "https://github.com/Org/Repo");
        assert_eq!(a.key, b.key);
        assert_eq!(a.key, c.key);
        assert_ne!(a.key, parse("https://github.com/org/repo").unwrap().key);
    }

    #[test]
    fn credentials_never_reach_the_fetch_url() {
        let r = parse("https://x-access-token:tok3n-value@github.com/o/r.git").unwrap();
        let shown = r.fetch_url.to_bstring().to_string();
        assert!(!shown.contains("tok3n-value"), "{shown}");
        assert!(!shown.contains("x-access-token"), "{shown}");
        let auth = r.url_auth.unwrap();
        assert_eq!(auth.username(), "x-access-token");
        assert!(!format!("{auth:?}").contains("tok3n-value"));
    }

    #[test]
    fn ssh_keeps_its_user_and_scp_form_normalises() {
        let r = parse("git@GitHub.com:o/r.git").unwrap();
        assert_eq!(r.normalised, "ssh://github.com/o/r");
        assert_eq!(r.fetch_url.user(), Some("git"));
    }

    #[test]
    fn unparsable_urls_do_not_echo_secrets() {
        let err = parse("https://u:topsecret@").unwrap_err().to_string();
        assert!(!err.contains("topsecret"), "{err}");
    }
}
