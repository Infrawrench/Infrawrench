//! Fetching what a lockfile pins.
//!
//! Every installer goes through [`Fetcher`], so tests swap in a
//! [`MemoryFetcher`] and never touch the network, and the production
//! fetcher can cache by content: two runs (or two repositories) that pin the
//! same tarball download it once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::Digest;

/// What a downloaded artifact must hash to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Integrity {
    /// A Subresource Integrity string as npm and pnpm lockfiles carry it:
    /// `sha512-<base64>` (also `sha384-`, `sha256-` and the legacy `sha1-`).
    Sri(String),
    /// A hex SHA-256, as `Cargo.lock`'s `checksum` carries it.
    Sha256Hex(String),
    /// A Go module zip, checked against `go.sum`'s `h1:` hash. That hash
    /// covers the module's files rather than the zip's bytes, so checking it
    /// means reading the zip (`go::zip_h1`), which is still done before
    /// anything is written or cached.
    GoModuleZip {
        module: String,
        version: String,
        h1: String,
    },
    /// A Go module's `go.mod`, checked against `go.sum`'s `/go.mod h1:`.
    GoMod { h1: String },
    /// Not checkable from the bytes alone, and never cached: Go's `.info`
    /// files, which no hash covers, and a `.mod` that `go.sum` does not pin
    /// (the installer checks it against the verified zip instead).
    VerifiedAfterExtraction,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("{url}: {message}")]
    Http { url: String, message: String },
    #[error("{url}: content does not match the lockfile's hash ({expected})")]
    IntegrityMismatch { url: String, expected: String },
    #[error("{url}: larger than the {limit} byte limit")]
    TooLarge { url: String, limit: u64 },
    #[error("unsupported integrity {0}")]
    UnsupportedIntegrity(String),
}

pub trait Fetcher: Send + Sync {
    /// The bytes at `url`, checked against `integrity` before they are
    /// returned. An implementation that caches must key the cache by the
    /// integrity, never by the URL alone, and must check cached bytes too.
    fn fetch(&self, url: &str, integrity: &Integrity) -> Result<Arc<[u8]>, FetchError>;
}

/// Checks `bytes` against `integrity`.
pub fn verify(url: &str, bytes: &[u8], integrity: &Integrity) -> Result<(), FetchError> {
    let mismatch = |expected: &str| FetchError::IntegrityMismatch {
        url: url.to_string(),
        expected: expected.to_string(),
    };
    match integrity {
        Integrity::VerifiedAfterExtraction => Ok(()),
        Integrity::GoModuleZip {
            module,
            version,
            h1,
        } => match crate::go::zip_h1(module, version, bytes) {
            Ok(actual) if actual == *h1 => Ok(()),
            _ => Err(mismatch(h1)),
        },
        Integrity::GoMod { h1 } => {
            if crate::go::hash_go_mod(bytes) == *h1 {
                Ok(())
            } else {
                Err(mismatch(h1))
            }
        }
        Integrity::Sha256Hex(hex_digest) => {
            let actual = hex::encode(sha2::Sha256::digest(bytes));
            if actual.eq_ignore_ascii_case(hex_digest) {
                Ok(())
            } else {
                Err(mismatch(hex_digest))
            }
        }
        Integrity::Sri(sri) => {
            // An SRI string may list several hashes separated by spaces; any
            // one of a supported algorithm matching is enough, as in npm.
            let mut supported = false;
            for part in sri.split_whitespace() {
                let Some((algo, b64)) = part.split_once('-') else {
                    continue;
                };
                let actual = match algo {
                    "sha512" => sha2::Sha512::digest(bytes).to_vec(),
                    "sha384" => sha2::Sha384::digest(bytes).to_vec(),
                    "sha256" => sha2::Sha256::digest(bytes).to_vec(),
                    _ => continue,
                };
                supported = true;
                if base64_eq(b64, &actual) {
                    return Ok(());
                }
            }
            if supported {
                Err(mismatch(sri))
            } else {
                Err(FetchError::UnsupportedIntegrity(sri.clone()))
            }
        }
    }
}

/// Whether the standard (padded or unpadded) base64 text `b64` encodes
/// `bytes`. Hand-rolled so this crate takes no base64 dependency for a
/// single comparison.
fn base64_eq(b64: &str, bytes: &[u8]) -> bool {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                encoded.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
    }
    encoded.trim_end_matches('=') == b64.trim_end_matches('=')
}

/// A fetcher over a fixed map of URL to bytes, for tests. It still verifies
/// integrity, so a test fixture with a wrong hash fails the way production
/// would.
#[derive(Debug, Default, Clone)]
pub struct MemoryFetcher {
    files: Arc<Mutex<HashMap<String, Arc<[u8]>>>>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl MemoryFetcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, url: impl Into<String>, bytes: impl Into<Vec<u8>>) {
        let bytes: Vec<u8> = bytes.into();
        self.files.lock().unwrap().insert(url.into(), bytes.into());
    }

    /// Every URL fetched so far, in order.
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Fetcher for MemoryFetcher {
    fn fetch(&self, url: &str, integrity: &Integrity) -> Result<Arc<[u8]>, FetchError> {
        self.requests.lock().unwrap().push(url.to_string());
        let bytes = self
            .files
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| FetchError::Http {
                url: url.to_string(),
                message: "404 Not Found".to_string(),
            })?;
        verify(url, &bytes, integrity)?;
        Ok(bytes)
    }
}

/// How many artifacts an installer fetches and unpacks at once. A monorepo
/// lockfile pins a couple of thousand tarballs, so one at a time spends the
/// install waiting on round trips; sixteen keeps a registry busy without
/// looking like abuse.
pub const DEFAULT_PARALLELISM: usize = 16;

/// `f` over every item on up to `threads` scoped threads, with the results
/// in input order. Work is handed out one item at a time, so one huge
/// artifact does not hold up a whole pre-assigned share of the list.
pub fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    threads: usize,
    f: impl Fn(&T) -> R + Sync,
) -> Vec<R> {
    let threads = threads.max(1).min(items.len());
    if threads <= 1 {
        return items.iter().map(f).collect();
    }
    let next = AtomicUsize::new(0);
    let f = &f;
    let next = &next;
    let mut slots: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(move || {
                    let mut done = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(index) else { break };
                        done.push((index, f(item)));
                    }
                    done
                })
            })
            .collect();
        for worker in workers {
            match worker.join() {
                Ok(done) => {
                    for (index, result) in done {
                        slots[index] = Some(result);
                    }
                }
                Err(panic) => std::panic::resume_unwind(panic),
            }
        }
    });
    slots
        .into_iter()
        .map(|slot| slot.expect("every item is mapped exactly once"))
        .collect()
}

/// Every `(url, integrity)` fetched through `fetcher` on up to `threads`
/// threads, results in input order. One failure does not stop the others,
/// so a caller can report every missing artifact at once.
pub fn fetch_all(
    fetcher: &dyn Fetcher,
    requests: &[(String, Integrity)],
    threads: usize,
) -> Vec<Result<Arc<[u8]>, FetchError>> {
    parallel_map(requests, threads, |(url, integrity)| {
        fetcher.fetch(url, integrity)
    })
}

/// The default per-artifact size limit. The largest npm tarballs (native
/// toolchains, browser engines) are a few hundred megabytes at most; a
/// response past this is a misconfigured mirror or an attack, and buffering
/// it would only exhaust memory.
pub const DEFAULT_MAX_ARTIFACT_BYTES: u64 = 512 << 20;

/// Redirects followed by hand (see [`HttpFetcher`]) before giving up.
const MAX_REDIRECTS: usize = 8;

/// The production fetcher: blocking HTTPS through `ureq` and rustls, with an
/// optional content-addressed disk cache.
///
/// The cache lives at `<dir>/<algorithm>/<first two hex>/<hex digest>`,
/// keyed by the strongest hash the lockfile gives. Cached bytes are verified
/// again on every read (a corrupted or tampered entry is deleted and
/// fetched afresh), and entries are written to a temporary file and renamed
/// into place, so concurrent runs sharing a cache never see half a file.
/// Artifacts with [`Integrity::VerifiedAfterExtraction`] are never cached,
/// because their key would have to be the URL.
///
/// Transient failures (connection errors, timeouts, 408, 429 and 5xx) are
/// retried with exponential backoff. Redirects are followed here rather
/// than by `ureq`, so a configured auth header is only ever sent to the
/// host it was configured for, never to wherever a registry redirects.
pub struct HttpFetcher {
    agent: ureq::Agent,
    cache_dir: Option<PathBuf>,
    max_bytes: u64,
    retries: u32,
    backoff: Duration,
    /// Lowercased `host` or `host:port` to the headers sent to it.
    headers: HashMap<String, Vec<(String, String)>>,
}

impl std::fmt::Debug for HttpFetcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Header values are credentials; only the hosts are shown.
        let mut hosts: Vec<&String> = self.headers.keys().collect();
        hosts.sort();
        f.debug_struct("HttpFetcher")
            .field("cache_dir", &self.cache_dir)
            .field("max_bytes", &self.max_bytes)
            .field("retries", &self.retries)
            .field("auth_hosts", &hosts)
            .finish_non_exhaustive()
    }
}

impl Default for HttpFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpFetcher {
    /// A fetcher with no cache, the default size limit and four retries.
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            // Statuses are classified below (retryable or not), and
            // redirects are followed by hand so auth headers stay put.
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .user_agent(concat!("iwci/", env!("CARGO_PKG_VERSION")))
            .max_idle_connections(4 * DEFAULT_PARALLELISM)
            .max_idle_connections_per_host(2 * DEFAULT_PARALLELISM)
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(120)))
            .timeout_recv_body(Some(Duration::from_secs(600)))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            cache_dir: None,
            max_bytes: DEFAULT_MAX_ARTIFACT_BYTES,
            retries: 4,
            backoff: Duration::from_millis(250),
            headers: HashMap::new(),
        }
    }

    /// Caches artifacts under `dir` (created on first write).
    pub fn with_cache_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cache_dir = Some(dir.into());
        self
    }

    /// Refuses any artifact larger than `bytes`.
    pub fn with_max_size(mut self, bytes: u64) -> Self {
        self.max_bytes = bytes;
        self
    }

    /// Retries a transient failure up to `retries` times, waiting
    /// `backoff`, then twice that, and so on (capped at ten seconds).
    pub fn with_retries(mut self, retries: u32, backoff: Duration) -> Self {
        self.retries = retries;
        self.backoff = backoff;
        self
    }

    /// Sends `name: value` with every request to `host` (a host name, or
    /// `host:port` for a non-default port), for example a private npm
    /// registry's token. The value is never logged or put in an error.
    pub fn with_header(
        mut self,
        host: &str,
        name: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        self.headers
            .entry(host.to_ascii_lowercase())
            .or_default()
            .push((name.into(), value.into()));
        self
    }

    /// `Authorization: Bearer <token>` for `host`, as an `.npmrc`
    /// `//host/:_authToken=` line configures it.
    pub fn with_bearer_token(self, host: &str, token: &str) -> Self {
        self.with_header(host, "Authorization", format!("Bearer {token}"))
    }

    fn cache_path(&self, integrity: &Integrity) -> Option<PathBuf> {
        let dir = self.cache_dir.as_ref()?;
        let (algorithm, hex_digest) = cache_key(integrity)?;
        Some(dir.join(algorithm).join(&hex_digest[..2]).join(&hex_digest))
    }

    fn read_cache(&self, path: &Path, url: &str, integrity: &Integrity) -> Option<Arc<[u8]>> {
        let bytes = std::fs::read(path).ok()?;
        if verify(url, &bytes, integrity).is_ok() {
            return Some(bytes.into());
        }
        // A bad entry (disk corruption, a truncated copy from an older
        // tool, tampering) is removed so the fresh download replaces it.
        let _ = std::fs::remove_file(path);
        None
    }

    fn write_cache(&self, path: &Path, bytes: &[u8]) {
        // The cache is an optimisation: failing to fill it (a full disk, a
        // read-only directory) must not fail the install that already has
        // the verified bytes in hand.
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let Some(dir) = path.parent() else { return };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let temp = dir.join(format!(
            ".tmp-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let written = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, path));
        if written.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }

    fn download(&self, url: &str) -> Result<Vec<u8>, FetchError> {
        let mut attempt = 0;
        loop {
            match self.download_once(url) {
                Ok(bytes) => return Ok(bytes),
                Err(Attempt::Retry(_)) if attempt < self.retries => {
                    let wait = self
                        .backoff
                        .saturating_mul(1 << attempt.min(16))
                        .min(Duration::from_secs(10));
                    std::thread::sleep(wait);
                    attempt += 1;
                }
                Err(Attempt::Retry(message)) => {
                    return Err(FetchError::Http {
                        url: url.to_string(),
                        message: format!("{message} (after {} attempts)", attempt + 1),
                    });
                }
                Err(Attempt::Fail(error)) => return Err(error),
            }
        }
    }

    fn download_once(&self, url: &str) -> Result<Vec<u8>, Attempt> {
        let http = |message: String| {
            Attempt::Fail(FetchError::Http {
                url: url.to_string(),
                message,
            })
        };
        let mut current = url.to_string();
        for _ in 0..=MAX_REDIRECTS {
            let Some(authority) = authority(&current) else {
                return Err(http(format!("not an http(s) URL: {current}")));
            };
            let mut request = self.agent.get(&current);
            if let Some(headers) = self.headers.get(&authority) {
                for (name, value) in headers {
                    request = request.header(name.as_str(), value.as_str());
                }
            }
            let mut response = match request.call() {
                Ok(response) => response,
                Err(error) => return Err(classify(error, url)),
            };
            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let Some(location) = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                else {
                    return Err(http(format!("HTTP {status} without a Location")));
                };
                current = resolve_location(&current, location);
                continue;
            }
            if status == 408 || status == 429 || status >= 500 {
                return Err(Attempt::Retry(format!("HTTP {status}")));
            }
            if !(200..300).contains(&status) {
                return Err(http(format!("HTTP {status}")));
            }
            let declared = response
                .headers()
                .get("content-length")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            if declared.is_some_and(|length| length > self.max_bytes) {
                return Err(Attempt::Fail(FetchError::TooLarge {
                    url: url.to_string(),
                    limit: self.max_bytes,
                }));
            }
            return match response
                .body_mut()
                .with_config()
                .limit(self.max_bytes)
                .read_to_vec()
            {
                Ok(bytes) => Ok(bytes),
                Err(ureq::Error::BodyExceedsLimit(_)) => Err(Attempt::Fail(FetchError::TooLarge {
                    url: url.to_string(),
                    limit: self.max_bytes,
                })),
                Err(error) => Err(classify(error, url)),
            };
        }
        Err(http(format!("more than {MAX_REDIRECTS} redirects")))
    }
}

impl Fetcher for HttpFetcher {
    fn fetch(&self, url: &str, integrity: &Integrity) -> Result<Arc<[u8]>, FetchError> {
        // An integrity this crate cannot check is refused before any
        // download, rather than after spending the bandwidth.
        verify_supported(integrity)?;
        let cache_path = self.cache_path(integrity);
        if let Some(path) = &cache_path
            && let Some(bytes) = self.read_cache(path, url, integrity)
        {
            return Ok(bytes);
        }
        let bytes = self.download(url)?;
        verify(url, &bytes, integrity)?;
        if let Some(path) = &cache_path {
            self.write_cache(path, &bytes);
        }
        Ok(bytes.into())
    }
}

/// Why one download attempt failed: worth retrying, or final.
enum Attempt {
    Retry(String),
    Fail(FetchError),
}

fn classify(error: ureq::Error, url: &str) -> Attempt {
    match error {
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::ConnectionFailed
        | ureq::Error::HostNotFound
        | ureq::Error::Protocol(_) => Attempt::Retry(error.to_string()),
        other => Attempt::Fail(FetchError::Http {
            url: url.to_string(),
            message: other.to_string(),
        }),
    }
}

/// Errors for an integrity no algorithm here can check.
fn verify_supported(integrity: &Integrity) -> Result<(), FetchError> {
    match integrity {
        Integrity::Sri(sri) if sri_digest(sri).is_none() => {
            Err(FetchError::UnsupportedIntegrity(sri.clone()))
        }
        _ => Ok(()),
    }
}

/// The cache directory and hex digest for `integrity`, using the strongest
/// algorithm an SRI string lists. `None` when the bytes cannot key a cache.
fn cache_key(integrity: &Integrity) -> Option<(&'static str, String)> {
    match integrity {
        Integrity::Sri(sri) => sri_digest(sri),
        Integrity::Sha256Hex(hex_digest) => {
            let valid = hex_digest.len() == 64 && hex_digest.bytes().all(|b| b.is_ascii_hexdigit());
            valid.then(|| ("sha256", hex_digest.to_ascii_lowercase()))
        }
        // Keyed by what was verified. The `h1:` text already names the
        // content; hashing it gives a fixed-length, path-safe name.
        Integrity::GoModuleZip {
            module,
            version,
            h1,
        } => Some((
            "go-zip",
            hex::encode(sha2::Sha256::digest(
                format!("{module}@{version} {h1}").as_bytes(),
            )),
        )),
        Integrity::GoMod { h1 } => {
            Some(("go-mod", hex::encode(sha2::Sha256::digest(h1.as_bytes()))))
        }
        Integrity::VerifiedAfterExtraction => None,
    }
}

fn sri_digest(sri: &str) -> Option<(&'static str, String)> {
    use base64::Engine;
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let mut best: Option<(usize, &'static str, Vec<u8>)> = None;
    for part in sri.split_whitespace() {
        let Some((algorithm, b64)) = part.split_once('-') else {
            continue;
        };
        // An SRI hash may carry `?options` after the digest.
        let b64 = b64.split('?').next().unwrap_or(b64);
        let (rank, name, length) = match algorithm {
            "sha512" => (3, "sha512", 64),
            "sha384" => (2, "sha384", 48),
            "sha256" => (1, "sha256", 32),
            _ => continue,
        };
        let Ok(digest) = engine.decode(b64) else {
            continue;
        };
        if digest.len() != length || best.as_ref().is_some_and(|(r, _, _)| *r >= rank) {
            continue;
        }
        best = Some((rank, name, digest));
    }
    best.map(|(_, name, digest)| (name, hex::encode(digest)))
}

/// `host[:port]` of an http(s) URL, lowercased, or `None` for any other
/// scheme. Userinfo is dropped so it can never select another host's auth.
fn authority(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let authority = authority.to_ascii_lowercase();
    // A default port is the same host as no port, for auth lookup.
    let authority = if url.starts_with("https://") {
        authority
            .strip_suffix(":443")
            .map(str::to_string)
            .unwrap_or(authority)
    } else {
        authority
            .strip_suffix(":80")
            .map(str::to_string)
            .unwrap_or(authority)
    };
    (!authority.is_empty()).then_some(authority)
}

/// A redirect's `Location` resolved against the URL that sent it. Covers
/// absolute URLs, scheme-relative (`//host/path`) and absolute paths, which
/// is everything registries and CDNs send; a bare relative path resolves
/// against the current directory.
fn resolve_location(base: &str, location: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.to_string();
    }
    let scheme_end = base.find("://").map_or(0, |i| i + 3);
    if let Some(rest) = location.strip_prefix("//") {
        return format!("{}{rest}", &base[..scheme_end]);
    }
    let path_start = base[scheme_end..]
        .find('/')
        .map_or(base.len(), |i| scheme_end + i);
    if location.starts_with('/') {
        return format!("{}{location}", &base[..path_start]);
    }
    let path = &base[path_start..];
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let dir_end = path.rfind('/').map_or(0, |i| i + 1);
    format!("{}{}{location}", &base[..path_start], &path[..dir_end])
}

#[cfg(test)]
mod http_tests {
    use super::*;

    #[test]
    fn cache_keys_use_the_strongest_listed_hash() {
        // sha256("abc") and sha512("abc"), as an npm lockfile would list both.
        let sha256 = "sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
        let sha512 = "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";
        let (algorithm, hex_digest) =
            cache_key(&Integrity::Sri(format!("{sha256} {sha512}"))).unwrap();
        assert_eq!(algorithm, "sha512");
        assert!(hex_digest.starts_with("ddaf35a193617aba"));
        let (algorithm, hex_digest) = cache_key(&Integrity::Sri(sha256.into())).unwrap();
        assert_eq!(algorithm, "sha256");
        assert_eq!(
            Some(("sha256", hex_digest)),
            cache_key(&Integrity::Sha256Hex(
                "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD".into()
            ))
        );
        assert_eq!(cache_key(&Integrity::VerifiedAfterExtraction), None);
        assert_eq!(
            cache_key(&Integrity::Sri("sha1-qZk+NkcGgWq6PiVxeFDCbJzQ2J0=".into())),
            None
        );
        assert!(verify("u", b"abc", &Integrity::Sri(sha512.into())).is_ok());
    }

    #[test]
    fn auth_is_looked_up_by_host_alone() {
        assert_eq!(
            authority("https://registry.npmjs.org/a/-/a-1.tgz").as_deref(),
            Some("registry.npmjs.org")
        );
        assert_eq!(
            authority("https://NPM.Example.com:443/x").as_deref(),
            Some("npm.example.com")
        );
        assert_eq!(
            authority("https://npm.example.com:8443/x").as_deref(),
            Some("npm.example.com:8443")
        );
        assert_eq!(
            authority("http://user:pw@evil.example/x").as_deref(),
            Some("evil.example")
        );
        assert_eq!(authority("file:///etc/passwd"), None);
    }

    #[test]
    fn redirect_locations_resolve_against_the_request() {
        let base = "https://registry.example.com/npm/a/-/a-1.0.0.tgz?x=1";
        assert_eq!(
            resolve_location(base, "https://cdn.example.net/b"),
            "https://cdn.example.net/b"
        );
        assert_eq!(
            resolve_location(base, "//cdn.example.net/b"),
            "https://cdn.example.net/b"
        );
        assert_eq!(
            resolve_location(base, "/blobs/1"),
            "https://registry.example.com/blobs/1"
        );
        assert_eq!(
            resolve_location(base, "b.tgz"),
            "https://registry.example.com/npm/a/-/b.tgz"
        );
    }

    #[test]
    fn the_cache_serves_verified_bytes_and_drops_bad_ones() {
        let dir = std::env::temp_dir().join(format!("iwci-fetch-test-{}", std::process::id()));
        let fetcher = HttpFetcher::new().with_cache_dir(&dir);
        let integrity =
            Integrity::Sri("sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=".into());
        let path = fetcher.cache_path(&integrity).unwrap();
        fetcher.write_cache(&path, b"abc");
        // The URL is unroutable: a hit must not touch the network.
        let bytes = fetcher
            .fetch("http://127.0.0.1:9/never", &integrity)
            .unwrap();
        assert_eq!(&bytes[..], b"abc");
        // A corrupted entry is deleted rather than served.
        std::fs::write(&path, b"abd").unwrap();
        assert!(fetcher.read_cache(&path, "u", &integrity).is_none());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Go zips and `.mod` files are cached under their go.sum hash, served
    /// from the cache without the network, and dropped when they no longer
    /// verify.
    #[test]
    fn go_artifacts_are_cached_by_their_go_sum_hash() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("iwci-fetch-go-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let fetcher = HttpFetcher::new().with_cache_dir(&dir);

        let go_mod = b"module example.com/m\n\ngo 1.21\n";
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file(
            "example.com/m@v1.0.0/go.mod",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(go_mod).unwrap();
        zip.start_file(
            "example.com/m@v1.0.0/m.go",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"package m\n").unwrap();
        let zip = zip.finish().unwrap().into_inner();

        let h1 = crate::go::zip_h1("example.com/m", "v1.0.0", &zip).unwrap();
        let zip_integrity = Integrity::GoModuleZip {
            module: "example.com/m".into(),
            version: "v1.0.0".into(),
            h1,
        };
        let mod_integrity = Integrity::GoMod {
            h1: crate::go::hash_go_mod(go_mod),
        };
        for (integrity, bytes) in [(&zip_integrity, &zip[..]), (&mod_integrity, &go_mod[..])] {
            let path = fetcher
                .cache_path(integrity)
                .expect("Go artifacts key a cache");
            fetcher.write_cache(&path, bytes);
            // The URL is unroutable: a hit must not touch the network.
            assert_eq!(
                &fetcher
                    .fetch("http://127.0.0.1:9/never", integrity)
                    .unwrap()[..],
                bytes
            );
            let mut bad = bytes.to_vec();
            let last = bad.len() - 1;
            bad[last] ^= 1;
            std::fs::write(&path, &bad).unwrap();
            assert!(fetcher.read_cache(&path, "u", integrity).is_none());
            assert!(!path.exists());
        }
        // A zip under another module's name does not verify, so it cannot
        // be served from the cache for that module.
        let other = Integrity::GoModuleZip {
            module: "example.com/other".into(),
            version: "v1.0.0".into(),
            h1: "h1:x".into(),
        };
        assert!(verify("u", &zip, &other).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parallel_map_keeps_input_order() {
        let items: Vec<u32> = (0..100).collect();
        let doubled = parallel_map(&items, 8, |n| n * 2);
        assert_eq!(doubled, items.iter().map(|n| n * 2).collect::<Vec<_>>());
        let fetcher = MemoryFetcher::new();
        fetcher.insert("a", b"abc".to_vec());
        let sri = Integrity::Sri("sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=".into());
        let results = fetch_all(&fetcher, &[("a".into(), sri.clone()), ("b".into(), sri)], 4);
        assert!(results[0].is_ok());
        assert!(matches!(results[1], Err(FetchError::Http { .. })));
    }

    /// A real download, to check the TLS stack and the registry's answers.
    #[test]
    #[ignore = "network"]
    fn downloads_a_tarball_from_the_npm_registry() {
        let fetcher = HttpFetcher::new();
        let integrity = Integrity::Sri(
            "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==".into(),
        );
        let bytes = fetcher
            .fetch(
                "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
                &integrity,
            )
            .unwrap();
        assert!(bytes.starts_with(&[0x1f, 0x8b]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sri_and_hex_checks() {
        // sha256("abc")
        let hex_abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify("u", b"abc", &Integrity::Sha256Hex(hex_abc.into())).is_ok());
        assert!(verify("u", b"abd", &Integrity::Sha256Hex(hex_abc.into())).is_err());
        let sri = "sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
        assert!(verify("u", b"abc", &Integrity::Sri(sri.into())).is_ok());
        assert!(verify("u", b"abd", &Integrity::Sri(sri.into())).is_err());
        assert!(matches!(
            verify(
                "u",
                b"abc",
                &Integrity::Sri("sha1-qZk+NkcGgWq6PiVxeFDCbJzQ2J0=".into())
            ),
            Err(FetchError::UnsupportedIntegrity(_))
        ));
    }
}
