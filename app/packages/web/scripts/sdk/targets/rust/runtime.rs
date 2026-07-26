// The hand-written half of the generated Rust SDK.
//
// This file is **not part of any cargo project in this repo** — the generator
// reads it off disk and inlines everything below the sentinel into the emitted
// `src/lib.rs`, ahead of the `mod` declarations' re-exports. Keeping it as real
// `.rs` source rather than a template string means it is syntax-highlighted,
// greppable and diffable like ordinary code, so a mistake in the request
// plumbing shows up here rather than inside a TypeScript string literal.
//
// The trade-off versus the TypeScript target's `runtime.ts`: that one is
// typechecked by the repo's own `pnpm typecheck`, whereas this one is only
// compiled once it has been emitted. `cargo build` in `sdk/rust/` is therefore
// the check that matters for this file.
//
// Two tokens are substituted at generation time — see `SUBSTITUTIONS` in
// `./index.ts`. Both are written as syntactically valid Rust so this file still
// parses on its own.

// --8<-- everything below this line is inlined into the generated SDK --8<--

use std::fmt;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Replaced with the first server advertised by the spec.
const DEFAULT_BASE_URL: &str = "@@BASE_URL@@";

/// The path parameter the client can carry as configuration rather than take on
/// every call. Replaced with `None` if the API has no such parameter.
const SCOPE_PARAM: Option<&str> = Some("@@SCOPE_PARAM@@");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// How to reach the API. Every field has a working default except the API key.
///
/// The setters consume and return `self` so a client can be built in one
/// expression: `ClientConfig::new().api_key(key).org_id(org)`.
#[derive(Debug, Clone, Default)]
pub struct ClientConfig {
    /// Base URL of the deployment. Defaults to the production API.
    pub base_url: Option<String>,
    /// API key or WorkOS access token, sent as `Authorization: Bearer <token>`.
    pub api_key: Option<String>,
    /// Default organization id, filled into org-scoped paths that omit one.
    pub org_id: Option<String>,
    /// Headers merged into every request.
    pub headers: Vec<(String, String)>,
    /// Abort requests after this long. No timeout by default.
    pub timeout: Option<Duration>,
    /// Supply your own `reqwest::Client` — for proxies, connection pools shared
    /// with the rest of your process, or a custom TLS configuration.
    pub http_client: Option<reqwest::Client>,
}

impl ClientConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn base_url(mut self, value: impl Into<String>) -> Self {
        self.base_url = Some(value.into());
        self
    }

    pub fn api_key(mut self, value: impl Into<String>) -> Self {
        self.api_key = Some(value.into());
        self
    }

    pub fn org_id(mut self, value: impl Into<String>) -> Self {
        self.org_id = Some(value.into());
        self
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn timeout(mut self, value: Duration) -> Self {
        self.timeout = Some(value);
        self
    }

    pub fn http_client(mut self, value: reqwest::Client) -> Self {
        self.http_client = Some(value);
        self
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// A non-2xx response, with everything needed to branch on it.
///
/// Prefer `code` over `message`: it is the machine-readable discriminator the
/// API sends (`reauthentication_required` on a step-up 403, for instance),
/// whereas the message is prose that may be reworded at any time.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: Option<String>,
    /// The response body, parsed as JSON when it was JSON and kept as a string
    /// otherwise, so an HTML error page from a proxy is not lost.
    pub body: serde_json::Value,
    pub message: String,
    pub method: String,
    pub url: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

/// Everything a call can fail with.
///
/// Marked `#[non_exhaustive]` so a future variant is not a breaking change for
/// callers who match on it — add a `_ =>` arm.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The API answered, and the answer was not 2xx.
    ///
    /// Boxed because every call in this crate returns `Result<_, Error>`, and an
    /// inline `ApiError` would make each of those results as wide as its largest
    /// failure — 136 bytes of error moved around on the success path too.
    Api(Box<ApiError>),
    /// The request never completed: DNS, TLS, connection, timeout.
    Http(reqwest::Error),
    /// A request body could not be serialized, or a response body did not match
    /// the shape the spec promised.
    Json(serde_json::Error),
    /// A path parameter had no value from the call or from client config.
    MissingPathParam {
        name: String,
        method: String,
        path: String,
    },
    /// The client itself is misconfigured — a base URL that will not parse, a
    /// header name that is not a valid header name.
    Config(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Api(error) => write!(f, "{error}"),
            Error::Http(error) => write!(f, "request failed: {error}"),
            Error::Json(error) => write!(f, "could not encode or decode JSON: {error}"),
            Error::MissingPathParam { name, method, path } => {
                write!(f, "missing path parameter `{name}` for {method} {path}")?;
                if SCOPE_PARAM == Some(name.as_str()) {
                    write!(
                        f,
                        " — pass it on the call, or set `{name}` on the ClientConfig"
                    )?;
                }
                Ok(())
            }
            Error::Config(message) => write!(f, "client is misconfigured: {message}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Api(error) => Some(error.as_ref()),
            Error::Http(error) => Some(error),
            Error::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Error::Http(error)
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Error::Json(error)
    }
}

impl Error {
    /// The `ApiError` behind this, when the failure came from the API rather
    /// than from the network or from serialization.
    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Error::Api(error) => Some(error.as_ref()),
            _ => None,
        }
    }

    /// HTTP status of an API failure.
    pub fn status(&self) -> Option<u16> {
        self.api().map(|error| error.status)
    }

    /// Machine-readable error code of an API failure, when the API sent one.
    pub fn code(&self) -> Option<&str> {
        self.api().and_then(|error| error.code.as_deref())
    }
}

// ---------------------------------------------------------------------------
// Request description
// ---------------------------------------------------------------------------

/// File bytes bound for a `multipart/form-data` field.
///
/// `Serialize`/`Deserialize` are derived only so this can sit inside generated
/// models alongside ordinary fields; the bytes never travel as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUpload {
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

impl FileUpload {
    pub fn new(file_name: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            file_name: file_name.into(),
            content_type: None,
            bytes,
        }
    }

    pub fn content_type(mut self, value: impl Into<String>) -> Self {
        self.content_type = Some(value.into());
        self
    }
}

/// One field of a `multipart/form-data` body.
#[derive(Debug, Clone)]
pub enum FormValue {
    Text(String),
    File(FileUpload),
}

/// A model that knows how to become a multipart body. Implemented by the
/// generator for exactly those schemas the spec sends as `multipart/form-data`.
pub trait IntoMultipart {
    fn into_multipart(self) -> Vec<(String, FormValue)>;
}

/// What the endpoint returns, which decides both the `Accept` header and how
/// the response body is read back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accept {
    Json,
    Binary,
    Empty,
}

/// A single HTTP call, as assembled by the generated namespace methods.
///
/// Public because the generated code builds one; it is not part of the stable
/// surface, and `APIV1Client` is what you should reach for.
#[derive(Debug)]
pub struct RequestSpec {
    pub method: &'static str,
    /// URL template with `{param}` placeholders.
    pub path: &'static str,
    /// Resolved path parameters. `None` means "fall back to client config".
    pub path_params: Vec<(&'static str, Option<String>)>,
    pub query: Vec<(String, String)>,
    pub body: Option<serde_json::Value>,
    pub form: Option<Vec<(String, FormValue)>>,
    pub accept: Accept,
}

impl RequestSpec {
    pub fn new(method: &'static str, path: &'static str) -> Self {
        Self {
            method,
            path,
            path_params: Vec::new(),
            query: Vec::new(),
            body: None,
            form: None,
            accept: Accept::Json,
        }
    }

    pub fn accept(mut self, accept: Accept) -> Self {
        self.accept = accept;
        self
    }

    /// Record a path parameter. Anything `Serialize` is accepted so generated
    /// enums (`PluginId`, `ResourceTypeId`) reach the URL as their wire value
    /// rather than as their Rust variant name.
    pub fn path_param<T: Serialize>(
        &mut self,
        name: &'static str,
        value: Option<&T>,
    ) -> Result<(), Error> {
        let rendered = match value {
            Some(value) => scalar_to_string(&serde_json::to_value(value)?),
            None => None,
        };
        self.path_params.push((name, rendered));
        Ok(())
    }

    /// Record a query parameter, dropping it when absent or null. Arrays are
    /// expanded into one repeated key per element.
    pub fn query_param<T: Serialize>(
        &mut self,
        name: &str,
        value: Option<&T>,
    ) -> Result<(), Error> {
        let Some(value) = value else { return Ok(()) };
        match serde_json::to_value(value)? {
            serde_json::Value::Null => {}
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(rendered) = scalar_to_string(&item) {
                        self.query.push((name.to_owned(), rendered));
                    }
                }
            }
            other => {
                if let Some(rendered) = scalar_to_string(&other) {
                    self.query.push((name.to_owned(), rendered));
                }
            }
        }
        Ok(())
    }

    pub fn json_body<T: Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.body = Some(serde_json::to_value(value)?);
        Ok(())
    }

    pub fn multipart_body<T: IntoMultipart>(&mut self, value: T) {
        self.form = Some(value.into_multipart());
    }
}

/// Render a JSON scalar the way a URL wants it: strings unquoted, `null`
/// dropped, anything structural left as compact JSON.
fn scalar_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        other => Some(other.to_string()),
    }
}

/// Percent-encode one path segment, escaping everything outside RFC 3986's
/// unreserved set — `/` included, so an id can never smuggle in a new segment.
fn encode_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// Request plumbing shared by every namespace.
///
/// Public because the generated namespace structs borrow one; reach for
/// `APIV1Client` instead.
#[derive(Debug, Clone)]
pub struct Transport {
    base_url: String,
    api_key: Option<String>,
    org_id: Option<String>,
    headers: HeaderMap,
    http: reqwest::Client,
}

impl Transport {
    pub fn new(config: ClientConfig) -> Result<Self, Error> {
        let base_url = config
            .base_url
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned())
            .trim_end_matches('/')
            .to_owned();
        // Parsed once, here, so a typo in the base URL is a construction error
        // rather than a surprise on the first call.
        Url::parse(&base_url).map_err(|error| {
            Error::Config(format!("base URL `{base_url}` does not parse: {error}"))
        })?;

        let mut headers = HeaderMap::new();
        for (name, value) in config.headers {
            let name = HeaderName::try_from(name.as_str())
                .map_err(|_| Error::Config(format!("`{name}` is not a valid header name")))?;
            let value = HeaderValue::try_from(value.as_str())
                .map_err(|_| Error::Config(format!("`{value}` is not a valid header value")))?;
            headers.insert(name, value);
        }

        let http = match config.http_client {
            Some(client) => client,
            None => {
                let mut builder = reqwest::Client::builder();
                if let Some(timeout) = config.timeout {
                    builder = builder.timeout(timeout);
                }
                builder.build().map_err(|error| {
                    Error::Config(format!("could not build an HTTP client: {error}"))
                })?
            }
        };

        Ok(Self {
            base_url,
            api_key: config.api_key,
            org_id: config.org_id,
            headers,
            http,
        })
    }

    /// The base URL every call is resolved against, with no trailing slash.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Fill `{param}` placeholders from the call, falling back to client config
    /// for the scope parameter.
    fn resolve_path(&self, spec: &RequestSpec) -> Result<String, Error> {
        let mut out = String::with_capacity(spec.path.len());
        let mut rest = spec.path;
        while let Some(open) = rest.find('{') {
            let Some(offset) = rest[open..].find('}') else {
                break;
            };
            let close = open + offset;
            out.push_str(&rest[..open]);
            let name = &rest[open + 1..close];
            let value = spec
                .path_params
                .iter()
                .find(|(key, _)| *key == name)
                .and_then(|(_, value)| value.clone())
                .or_else(|| {
                    if SCOPE_PARAM == Some(name) {
                        self.org_id.clone()
                    } else {
                        None
                    }
                })
                .filter(|value| !value.is_empty())
                .ok_or_else(|| Error::MissingPathParam {
                    name: name.to_owned(),
                    method: spec.method.to_owned(),
                    path: spec.path.to_owned(),
                })?;
            out.push_str(&encode_path_segment(&value));
            rest = &rest[close + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn build_url(&self, spec: &RequestSpec) -> Result<Url, Error> {
        let path = self.resolve_path(spec)?;
        let mut url = Url::parse(&format!("{}{}", self.base_url, path))
            .map_err(|error| Error::Config(format!("could not build a URL: {error}")))?;
        if !spec.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &spec.query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    async fn execute(&self, spec: RequestSpec) -> Result<(StatusCode, Vec<u8>), Error> {
        let url = self.build_url(&spec)?;
        let method_name = spec.method;
        let method = Method::from_bytes(method_name.as_bytes())
            .map_err(|_| Error::Config(format!("`{method_name}` is not an HTTP method")))?;

        let mut request = self.http.request(method, url.clone());
        request = request.headers(self.headers.clone());
        request = request.header(
            reqwest::header::ACCEPT,
            match spec.accept {
                Accept::Binary => "application/octet-stream",
                Accept::Json | Accept::Empty => "application/json",
            },
        );
        if let Some(api_key) = self.api_key.as_deref().filter(|key| !key.is_empty()) {
            request = request.bearer_auth(api_key);
        }

        if let Some(fields) = spec.form {
            // Content-Type is left to reqwest: it owns the multipart boundary.
            let mut form = reqwest::multipart::Form::new();
            for (name, value) in fields {
                form = match value {
                    FormValue::Text(text) => form.text(name, text),
                    FormValue::File(file) => {
                        let mut part =
                            reqwest::multipart::Part::bytes(file.bytes).file_name(file.file_name);
                        if let Some(content_type) = file.content_type {
                            part = part.mime_str(&content_type)?;
                        }
                        form.part(name, part)
                    }
                };
            }
            request = request.multipart(form);
        } else if let Some(body) = spec.body.as_ref() {
            request = request.json(body);
        }

        let response = request.send().await?;
        let status = response.status();
        let bytes = response.bytes().await?.to_vec();
        if !status.is_success() {
            return Err(Error::Api(Box::new(to_api_error(
                status,
                &bytes,
                method_name,
                url.as_str(),
            ))));
        }
        Ok((status, bytes))
    }

    /// Send `spec` and decode a JSON response.
    pub async fn json<T: DeserializeOwned>(&self, spec: RequestSpec) -> Result<T, Error> {
        let (status, bytes) = self.execute(spec).await?;
        // A 204 (or an empty body from a route that declares one) is `null` as
        // far as serde is concerned, which is what `Option<T>` and `()` want.
        if bytes.is_empty() || status == StatusCode::NO_CONTENT {
            return Ok(serde_json::from_value(serde_json::Value::Null)?);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Send `spec` and return the response body verbatim.
    pub async fn bytes(&self, spec: RequestSpec) -> Result<Vec<u8>, Error> {
        let (_, bytes) = self.execute(spec).await?;
        Ok(bytes)
    }

    /// Send `spec` and discard the response body.
    pub async fn empty(&self, spec: RequestSpec) -> Result<(), Error> {
        self.execute(spec).await?;
        Ok(())
    }
}

fn to_api_error(status: StatusCode, bytes: &[u8], method: &str, url: &str) -> ApiError {
    let body = serde_json::from_slice::<serde_json::Value>(bytes)
        .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()));
    let detail = body
        .get("error")
        .and_then(|value| value.as_str())
        .or_else(|| body.get("message").and_then(|value| value.as_str()))
        .map(|text| text.to_owned())
        .unwrap_or_else(|| status.to_string());
    ApiError {
        status: status.as_u16(),
        code: body
            .get("code")
            .and_then(|value| value.as_str())
            .map(|text| text.to_owned()),
        message: format!("{method} {url} failed: {detail}"),
        body,
        method: method.to_owned(),
        url: url.to_owned(),
    }
}
