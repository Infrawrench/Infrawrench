//! Cloudflare R2 through its S3-compatible API.
//!
//! Endpoint `https://<account_id>.r2.cloudflarestorage.com`, region `auto`
//! (developers.cloudflare.com/r2/api/s3/api/). The operations used are
//! GetObject, HeadObject, PutObject (with `If-None-Match: *` for
//! create-only writes) and ListObjectsV2 with `continuation-token`,
//! `encoding-type=url`, `max-keys` and `prefix`, all of which that page lists
//! as supported.

mod sigv4;
mod xml;

use std::fmt;
use std::hash::BuildHasher as _;
use std::time::Duration;

use zeroize::Zeroizing;

use crate::error::StoreError;
use crate::keys::{sha256_hex, validate_key, validate_prefix};
use crate::store::{MAX_OBJECT_SIZE, ObjectMeta, ObjectStore, check_size};

/// An R2 API token's S3 credentials.
///
/// `Debug` prints neither half, and the secret is zeroed on drop, so the
/// credentials can sit inside structs that get logged.
#[derive(Clone)]
pub struct Credentials {
    access_key_id: String,
    secret_access_key: Zeroizing<String>,
}

impl Credentials {
    /// Wraps an access key id and secret access key.
    pub fn new(access_key_id: impl Into<String>, secret_access_key: impl Into<String>) -> Self {
        Self {
            access_key_id: access_key_id.into(),
            secret_access_key: Zeroizing::new(secret_access_key.into()),
        }
    }

    pub(crate) fn access_key_id(&self) -> &str {
        &self.access_key_id
    }

    pub(crate) fn secret(&self) -> &str {
        &self.secret_access_key
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &"<redacted>")
            .field("secret_access_key", &"<redacted>")
            .finish()
    }
}

/// How the bucket is addressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UrlStyle {
    /// `https://<endpoint>/<bucket>/<key>`. The default: it works with any
    /// endpoint, including a loopback test server and IP addresses.
    #[default]
    Path,
    /// `https://<bucket>.<endpoint>/<key>`.
    VirtualHost,
}

/// When and how often to retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts, including the first. At least 1.
    pub max_attempts: u32,
    /// Delay before the first retry; doubled each time.
    pub base_delay: Duration,
    /// Upper bound on any one delay.
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            base_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
        }
    }
}

impl RetryPolicy {
    /// Exponential backoff with "equal jitter": half the delay is fixed, half
    /// random, so a fleet of runners that failed together does not retry in
    /// lockstep.
    fn delay(&self, retry: u32) -> Duration {
        let exp = self
            .base_delay
            .saturating_mul(1u32 << retry.saturating_sub(1).min(16))
            .min(self.max_delay);
        let random = std::collections::hash_map::RandomState::new().hash_one(retry);
        let half = exp / 2;
        half + half.mul_f64((random % 1000) as f64 / 1000.0)
    }
}

/// Knobs for [`R2Store`].
#[derive(Debug, Clone)]
pub struct R2Options {
    /// Path or virtual-hosted addressing.
    pub url_style: UrlStyle,
    /// Retries for 5xx, 429 and transport failures.
    pub retry: RetryPolicy,
    /// Whole-request timeout. Generous by default because a 256 MiB blob on
    /// a slow link legitimately takes a while.
    pub timeout: Duration,
    /// The SigV4 region. R2 wants `auto`.
    pub region: String,
    /// Keys per ListObjectsV2 page (R2 and S3 cap it at 1000).
    pub list_page_size: u32,
}

impl Default for R2Options {
    fn default() -> Self {
        Self {
            url_style: UrlStyle::Path,
            retry: RetryPolicy::default(),
            timeout: Duration::from_secs(600),
            region: "auto".to_owned(),
            list_page_size: 1000,
        }
    }
}

#[derive(Debug, Clone)]
struct Endpoint {
    scheme: &'static str,
    /// Host and, when not the default, `:port`.
    authority: String,
}

impl Endpoint {
    fn parse(url: &str) -> Result<Self, StoreError> {
        let err = |m: &str| StoreError::Config(format!("endpoint {url:?}: {m}"));
        let (scheme, rest) = if let Some(r) = url.strip_prefix("https://") {
            ("https", r)
        } else if let Some(r) = url.strip_prefix("http://") {
            ("http", r)
        } else {
            return Err(err("must start with https://"));
        };
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
            let (h, after) = v6
                .split_once(']')
                .ok_or_else(|| err("unclosed IPv6 bracket"))?;
            (format!("[{h}]"), after.strip_prefix(':'))
        } else {
            match authority.split_once(':') {
                Some((h, p)) => (h.to_owned(), Some(p)),
                None => (authority.to_owned(), None),
            }
        };
        let host_ok = !host.is_empty()
            && host.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'[' | b']' | b':')
            });
        if !host_ok {
            return Err(err(
                "host must be a plain hostname or IP, with no path or credentials",
            ));
        }
        let port = match port {
            Some(p) => Some(p.parse::<u16>().map_err(|_| err("bad port"))?),
            None => None,
        };
        // Plain HTTP would send the signed requests (and every byte we then
        // execute) in the clear, so it is only allowed to this machine, which
        // is what tests and a local S3 emulator need.
        let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
        if scheme == "http" && !loopback {
            return Err(err("plain http is only allowed to a loopback address"));
        }
        let default_port = if scheme == "https" { 443 } else { 80 };
        let authority = match port {
            Some(p) if p != default_port => format!("{host}:{p}"),
            _ => host,
        };
        Ok(Self { scheme, authority })
    }
}

/// The endpoint for an account: `https://<account_id>.r2.cloudflarestorage.com`.
///
/// Buckets created in a jurisdiction use `https://<account_id>.<jurisdiction>.r2.cloudflarestorage.com`
/// instead (for example `eu`); pass that to [`R2Store::with_endpoint`].
pub fn account_endpoint(account_id: &str) -> Result<String, StoreError> {
    if account_id.is_empty()
        || account_id.len() > 64
        || !account_id.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(StoreError::Config(
            "account id must be alphanumeric (a Cloudflare account id is 32 hex digits)".into(),
        ));
    }
    Ok(format!("https://{account_id}.r2.cloudflarestorage.com"))
}

/// An [`ObjectStore`] over R2's S3 API, blocking.
pub struct R2Store {
    endpoint: Endpoint,
    bucket: String,
    credentials: Credentials,
    options: R2Options,
    agent: ureq::Agent,
}

impl fmt::Debug for R2Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("R2Store")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("credentials", &self.credentials)
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

/// What one attempt produced.
enum Attempt<T> {
    Done(T),
    Retry(StoreError),
    Fail(StoreError),
}

struct Exchange {
    status: u16,
    body: Vec<u8>,
    content_length: Option<u64>,
}

/// Error bodies are a few hundred bytes of XML; anything larger is not one.
const ERROR_BODY_LIMIT: u64 = 64 * 1024;
/// A ListObjectsV2 page of 1000 keys of at most 1024 bytes each, with slack.
const LIST_BODY_LIMIT: u64 = 8 * 1024 * 1024;
/// A hard stop on pagination, so a server that keeps handing out tokens
/// cannot keep us listing forever.
const MAX_LIST_PAGES: usize = 10_000;

impl R2Store {
    /// A store for `bucket` in the given account, with default options.
    pub fn new(
        account_id: &str,
        bucket: &str,
        credentials: Credentials,
    ) -> Result<Self, StoreError> {
        Self::with_endpoint(
            &account_endpoint(account_id)?,
            bucket,
            credentials,
            R2Options::default(),
        )
    }

    /// A store at an explicit endpoint (a jurisdiction endpoint, or a
    /// loopback emulator in tests).
    pub fn with_endpoint(
        endpoint: &str,
        bucket: &str,
        credentials: Credentials,
        options: R2Options,
    ) -> Result<Self, StoreError> {
        let endpoint = Endpoint::parse(endpoint)?;
        // R2 bucket names: lowercase letters, digits and hyphens, 3 to 63
        // characters, not starting or ending with a hyphen.
        let bucket_ok = (3..=63).contains(&bucket.len())
            && bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !bucket.starts_with('-')
            && !bucket.ends_with('-');
        if !bucket_ok {
            return Err(StoreError::Config(format!(
                "bucket {bucket:?} is not a valid R2 bucket name"
            )));
        }
        if options.retry.max_attempts == 0 || !(1..=1000).contains(&options.list_page_size) {
            return Err(StoreError::Config(
                "max_attempts must be at least 1 and list_page_size between 1 and 1000".into(),
            ));
        }
        let agent = ureq::Agent::config_builder()
            // Statuses are classified here, not turned into errors by ureq.
            .http_status_as_error(false)
            // S3 does not redirect a correctly addressed request; following
            // one could carry the signed request somewhere else.
            .max_redirects(0)
            .timeout_global(Some(options.timeout))
            .timeout_connect(Some(Duration::from_secs(30)))
            .build()
            .new_agent();
        Ok(Self {
            endpoint,
            bucket: bucket.to_owned(),
            credentials,
            options,
            agent,
        })
    }

    /// Host header and absolute path for an object key (or the bucket root
    /// when `key` is `None`).
    fn locate(&self, key: Option<&str>) -> (String, String) {
        let encoded = key.map(|k| sigv4::uri_encode(k, true));
        match self.options.url_style {
            UrlStyle::Path => {
                let path = match encoded {
                    Some(k) => format!("/{}/{k}", self.bucket),
                    None => format!("/{}", self.bucket),
                };
                (self.endpoint.authority.clone(), path)
            }
            UrlStyle::VirtualHost => (
                format!("{}.{}", self.bucket, self.endpoint.authority),
                format!("/{}", encoded.unwrap_or_default()),
            ),
        }
    }

    fn url(&self, host: &str, path: &str, query: &str) -> String {
        if query.is_empty() {
            format!("{}://{host}{path}", self.endpoint.scheme)
        } else {
            format!("{}://{host}{path}?{query}", self.endpoint.scheme)
        }
    }

    /// One signed request, with retries. `label` is the key or prefix used in
    /// error messages, never the URL.
    #[allow(clippy::too_many_arguments)]
    fn request(
        &self,
        method: &'static str,
        label: &str,
        key: Option<&str>,
        query: &str,
        body: Option<&[u8]>,
        headers: &[(&str, &str)],
        limit: u64,
    ) -> Result<Exchange, StoreError> {
        let (host, path) = self.locate(key);
        let url = self.url(&host, &path, query);
        let payload_sha256 = match body {
            Some(b) => sha256_hex(b),
            None => sigv4::EMPTY_SHA256.to_owned(),
        };
        let mut attempt = 0;
        loop {
            attempt += 1;
            // Signed afresh each attempt: the date is part of the signature
            // and R2 rejects one more than 15 minutes old.
            let signed = sigv4::sign(
                &self.credentials,
                &self.options.region,
                &sigv4::AmzDate::now(),
                &sigv4::Request {
                    method,
                    host: &host,
                    path: &path,
                    query,
                    headers,
                    payload_sha256: &payload_sha256,
                },
            );
            match self.attempt(method, label, &url, &signed, body, headers, limit) {
                Attempt::Done(x) => return Ok(x),
                Attempt::Fail(e) => return Err(e),
                Attempt::Retry(e) => {
                    if attempt >= self.options.retry.max_attempts {
                        return Err(e);
                    }
                    std::thread::sleep(self.options.retry.delay(attempt));
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn attempt(
        &self,
        method: &'static str,
        label: &str,
        url: &str,
        signed: &sigv4::Signed,
        body: Option<&[u8]>,
        headers: &[(&str, &str)],
        limit: u64,
    ) -> Attempt<Exchange> {
        let transport = |e: ureq::Error| {
            let err = StoreError::Transport {
                method,
                key: label.to_owned(),
                message: e.to_string(),
            };
            match e {
                ureq::Error::Io(_)
                | ureq::Error::Timeout(_)
                | ureq::Error::ConnectionFailed
                | ureq::Error::HostNotFound
                | ureq::Error::Protocol(_)
                | ureq::Error::BodyStalled => Attempt::Retry(err),
                ureq::Error::BodyExceedsLimit(_) => Attempt::Fail(StoreError::TooLarge {
                    key: label.to_owned(),
                    limit,
                }),
                _ => Attempt::Fail(err),
            }
        };
        let mut builder = ureq::http::Request::builder()
            .method(method)
            .uri(url)
            .header("authorization", &signed.authorization)
            .header("x-amz-date", &signed.amz_date)
            .header("x-amz-content-sha256", &signed.content_sha256);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let response = match body {
            Some(b) => builder.body(b).map(|r| self.agent.run(r)),
            None => builder.body(()).map(|r| self.agent.run(r)),
        };
        let response = match response {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return transport(e),
            Err(e) => {
                return Attempt::Fail(StoreError::Config(format!("building request: {e}")));
            }
        };
        let status = response.status().as_u16();
        let content_length = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let body_limit = if (200..300).contains(&status) {
            limit
        } else {
            ERROR_BODY_LIMIT
        };
        let body = if method == "HEAD" {
            Vec::new()
        } else {
            match response
                .into_body()
                .into_with_config()
                .limit(body_limit)
                .read_to_vec()
            {
                Ok(b) => b,
                Err(e) => return transport(e),
            }
        };
        if status >= 500 || status == 429 {
            return Attempt::Retry(StoreError::Http {
                method,
                key: label.to_owned(),
                status,
                code: xml::error_code(&String::from_utf8_lossy(&body)),
            });
        }
        Attempt::Done(Exchange {
            status,
            body,
            content_length,
        })
    }

    fn http_error(method: &'static str, label: &str, x: &Exchange) -> StoreError {
        StoreError::Http {
            method,
            key: label.to_owned(),
            status: x.status,
            code: xml::error_code(&String::from_utf8_lossy(&x.body)),
        }
    }

    fn list_page(&self, prefix: &str, token: Option<&str>) -> Result<xml::ListPage, StoreError> {
        let page_size = self.options.list_page_size.to_string();
        let mut params = vec![
            ("list-type", "2"),
            ("encoding-type", "url"),
            ("max-keys", page_size.as_str()),
        ];
        if !prefix.is_empty() {
            params.push(("prefix", prefix));
        }
        if let Some(t) = token {
            params.push(("continuation-token", t));
        }
        let query = sigv4::canonical_query(&params);
        let x = self.request("GET", prefix, None, &query, None, &[], LIST_BODY_LIMIT)?;
        if x.status != 200 {
            return Err(Self::http_error("GET", prefix, &x));
        }
        let doc = std::str::from_utf8(&x.body).map_err(|_| StoreError::InvalidResponse {
            what: "listing response is not UTF-8".into(),
        })?;
        xml::parse_list(doc)
    }
}

impl ObjectStore for R2Store {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        validate_key(key)?;
        let x = self.request("GET", key, Some(key), "", None, &[], MAX_OBJECT_SIZE)?;
        match x.status {
            200 => {
                // A body shorter than its Content-Length means the connection
                // dropped mid-object; the catalog would catch it by hash, but
                // saying what happened is kinder.
                if x.content_length.is_some_and(|n| n != x.body.len() as u64) {
                    return Err(StoreError::InvalidResponse {
                        what: format!("{key}: body length differs from Content-Length"),
                    });
                }
                Ok(Some(x.body))
            }
            404 => Ok(None),
            _ => Err(Self::http_error("GET", key, &x)),
        }
    }

    fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
        validate_key(key)?;
        let x = self.request("HEAD", key, Some(key), "", None, &[], 0)?;
        match x.status {
            200 => {
                let size = x
                    .content_length
                    .ok_or_else(|| StoreError::InvalidResponse {
                        what: format!("{key}: HEAD without Content-Length"),
                    })?;
                Ok(Some(ObjectMeta { size }))
            }
            404 => Ok(None),
            _ => Err(Self::http_error("HEAD", key, &x)),
        }
    }

    fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), StoreError> {
        validate_key(key)?;
        check_size(key, bytes.len())?;
        let headers = [("content-type", content_type)];
        let x = self.request(
            "PUT",
            key,
            Some(key),
            "",
            Some(bytes),
            &headers,
            ERROR_BODY_LIMIT,
        )?;
        match x.status {
            200..=299 => Ok(()),
            _ => Err(Self::http_error("PUT", key, &x)),
        }
    }

    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<bool, StoreError> {
        validate_key(key)?;
        check_size(key, bytes.len())?;
        let headers = [("content-type", content_type), ("if-none-match", "*")];
        let x = self.request(
            "PUT",
            key,
            Some(key),
            "",
            Some(bytes),
            &headers,
            ERROR_BODY_LIMIT,
        )?;
        match x.status {
            200..=299 => Ok(true),
            // 412 is the documented answer; R2's docs also mention 304 for
            // conditional uploads that are "not necessary".
            412 | 304 => Ok(false),
            _ => Err(Self::http_error("PUT", key, &x)),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        validate_prefix(prefix)?;
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let page = self.list_page(prefix, token.as_deref())?;
            // Only keys in our grammar and under the asked prefix count; a
            // server that answers with anything else does not get to steer
            // the catalog outside the namespace it listed.
            keys.extend(
                page.keys
                    .into_iter()
                    .filter(|k| k.starts_with(prefix) && validate_key(k).is_ok()),
            );
            match page.next_token {
                None => {
                    keys.sort();
                    keys.dedup();
                    return Ok(keys);
                }
                Some(next) if token.as_deref() == Some(next.as_str()) => {
                    return Err(StoreError::InvalidResponse {
                        what: format!("listing {prefix}: continuation token did not advance"),
                    });
                }
                Some(next) => token = Some(next),
            }
        }
        Err(StoreError::InvalidResponse {
            what: format!("listing {prefix}: more than {MAX_LIST_PAGES} pages"),
        })
    }
}

#[cfg(test)]
mod tests;
