//! `R2Store` against a tiny S3 emulator on 127.0.0.1. The emulator checks
//! every request's SigV4 signature by recomputing it from what actually
//! arrived on the socket (the `Host` header ureq wrote, the query string it
//! sent, the headers named in `SignedHeaders`), so these tests catch any
//! difference between what the store signs and what the HTTP client sends.

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;

const BUCKET: &str = "ci-bucket";

#[derive(Default)]
struct State {
    objects: Mutex<BTreeMap<String, Vec<u8>>>,
    /// Answer this many upcoming requests with 503 before serving them.
    fail_next: AtomicU32,
    /// Request lines seen, for asserting on pagination.
    log: Mutex<Vec<String>>,
    /// Signatures that did not verify.
    bad_signatures: AtomicU32,
}

fn creds() -> Credentials {
    Credentials::new("test-key-id", "test-secret")
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut headers = BTreeMap::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (k, v) = h.split_once(':')?;
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
    }
    let len = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; len];
    reader.read_exact(&mut body).ok()?;
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_owned(), q.to_owned()),
        None => (target, String::new()),
    };
    Some(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

fn query_params(q: &str) -> BTreeMap<String, String> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

fn signature_ok(req: &Request) -> bool {
    let Some(auth) = req.headers.get("authorization") else {
        return false;
    };
    let Some(signed_headers) = auth
        .split(", ")
        .find_map(|p| p.strip_prefix("SignedHeaders="))
    else {
        return false;
    };
    let extra: Vec<(&str, &str)> = signed_headers
        .split(';')
        .filter(|h| !matches!(*h, "host" | "x-amz-date" | "x-amz-content-sha256"))
        .map(|h| (h, req.headers.get(h).map(String::as_str).unwrap_or("")))
        .collect();
    let payload = req
        .headers
        .get("x-amz-content-sha256")
        .cloned()
        .unwrap_or_default();
    if payload != sha256_hex(&req.body) {
        return false;
    }
    // Re-canonicalise the query from its decoded parameters: the result must
    // be byte-identical to what was sent, or the client is sending one query
    // and signing another.
    let params = query_params(&req.query);
    let pairs: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let query = sigv4::canonical_query(&pairs);
    if query != req.query {
        return false;
    }
    let date = sigv4::AmzDate(req.headers.get("x-amz-date").cloned().unwrap_or_default());
    let expected = sigv4::sign(
        &creds(),
        "auto",
        &date,
        &sigv4::Request {
            method: &req.method,
            host: req.headers.get("host").map(String::as_str).unwrap_or(""),
            path: &req.path,
            query: &query,
            headers: &extra,
            payload_sha256: &payload,
        },
    );
    &expected.authorization == auth
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, String)],
    body: &[u8],
    head: bool,
) {
    let mut out = format!("HTTP/1.1 {status} X\r\nconnection: close\r\n");
    let mut has_len = false;
    for (k, v) in headers {
        has_len |= *k == "content-length";
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    if !has_len {
        out.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    out.push_str("\r\n");
    let _ = stream.write_all(out.as_bytes());
    if !head {
        let _ = stream.write_all(body);
    }
}

fn error_xml(code: &str) -> Vec<u8> {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>x</Message></Error>")
        .into_bytes()
}

fn handle(state: &State, mut stream: TcpStream) {
    let Some(req) = read_request(&stream) else {
        return;
    };
    state
        .log
        .lock()
        .unwrap()
        .push(format!("{} {}?{}", req.method, req.path, req.query));
    if state
        .fail_next
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .is_ok()
    {
        return respond(
            &mut stream,
            503,
            &[],
            &error_xml("ServiceUnavailable"),
            false,
        );
    }
    if !signature_ok(&req) {
        state.bad_signatures.fetch_add(1, Ordering::SeqCst);
        return respond(
            &mut stream,
            403,
            &[],
            &error_xml("SignatureDoesNotMatch"),
            false,
        );
    }
    let head = req.method == "HEAD";
    let bucket_root = format!("/{BUCKET}");
    if req.path == bucket_root && req.method == "GET" {
        let params = query_params(&req.query);
        assert_eq!(params.get("list-type").map(String::as_str), Some("2"));
        let prefix = params.get("prefix").cloned().unwrap_or_default();
        let max: usize = params["max-keys"].parse().unwrap();
        // Tokens are deliberately full of characters that need encoding.
        let start: usize = params
            .get("continuation-token")
            .map(|t| {
                t.trim_start_matches("t/+")
                    .trim_end_matches("==")
                    .parse()
                    .unwrap()
            })
            .unwrap_or(0);
        let objects = state.objects.lock().unwrap();
        let all: Vec<&String> = objects.keys().filter(|k| k.starts_with(&prefix)).collect();
        let page = &all[start.min(all.len())..(start + max).min(all.len())];
        let truncated = start + max < all.len();
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
             <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
             <EncodingType>url</EncodingType>",
        );
        xml.push_str(&format!("<IsTruncated>{truncated}</IsTruncated>"));
        for k in page {
            xml.push_str(&format!(
                "<Contents><Key>{}</Key><Size>1</Size></Contents>",
                sigv4::uri_encode(k, false)
            ));
        }
        if truncated {
            xml.push_str(&format!(
                "<NextContinuationToken>t/+{}==</NextContinuationToken>",
                start + max
            ));
        }
        xml.push_str("</ListBucketResult>");
        return respond(&mut stream, 200, &[], xml.as_bytes(), false);
    }
    let Some(key) = req.path.strip_prefix(&format!("{bucket_root}/")) else {
        return respond(&mut stream, 400, &[], &error_xml("InvalidRequest"), false);
    };
    let key = percent_decode(key);
    let mut objects = state.objects.lock().unwrap();
    match req.method.as_str() {
        "GET" | "HEAD" => match objects.get(&key) {
            Some(b) => respond(
                &mut stream,
                200,
                &[("content-type", "application/octet-stream".into())],
                b,
                head,
            ),
            None => respond(&mut stream, 404, &[], &error_xml("NoSuchKey"), head),
        },
        "PUT" => {
            if req.headers.get("if-none-match").map(String::as_str) == Some("*")
                && objects.contains_key(&key)
            {
                return respond(
                    &mut stream,
                    412,
                    &[],
                    &error_xml("PreconditionFailed"),
                    false,
                );
            }
            objects.insert(key, req.body);
            respond(&mut stream, 200, &[("etag", "\"x\"".into())], b"", false);
        }
        _ => respond(&mut stream, 405, &[], &error_xml("MethodNotAllowed"), false),
    }
}

fn serve() -> (Arc<State>, String) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(State::default());
    let s = state.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let s = s.clone();
            std::thread::spawn(move || handle(&s, stream));
        }
    });
    (state, format!("http://{addr}"))
}

fn fast_options(page: u32) -> R2Options {
    R2Options {
        retry: RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(5),
        },
        timeout: Duration::from_secs(10),
        list_page_size: page,
        ..R2Options::default()
    }
}

#[test]
fn full_request_path_against_emulator() {
    let (state, endpoint) = serve();
    let store = R2Store::with_endpoint(&endpoint, BUCKET, creds(), fast_options(2)).unwrap();

    assert_eq!(store.get("blobs/sha256/missing").unwrap(), None);
    assert_eq!(store.head("blobs/sha256/missing").unwrap(), None);
    store
        .put("builtins/tsc/7.1.3.json", b"{\"a\":1}", "application/json")
        .unwrap();
    assert_eq!(
        store.get("builtins/tsc/7.1.3.json").unwrap().unwrap(),
        b"{\"a\":1}"
    );
    assert_eq!(
        store.head("builtins/tsc/7.1.3.json").unwrap().unwrap().size,
        7
    );

    assert!(
        store
            .put_if_absent("builtins/tsc/7.1.4.json", b"one", "application/json")
            .unwrap()
    );
    assert!(
        !store
            .put_if_absent("builtins/tsc/7.1.4.json", b"two", "application/json")
            .unwrap()
    );
    assert_eq!(
        store.get("builtins/tsc/7.1.4.json").unwrap().unwrap(),
        b"one"
    );

    // Five keys under the prefix at two per page: three pages, with tokens
    // that only survive if they are encoded correctly.
    for v in ["7.2.0", "7.3.0", "8.0.0"] {
        store
            .put(&format!("builtins/tsc/{v}.json"), b"x", "application/json")
            .unwrap();
    }
    store
        .put("builtins/tscx/1.0.0.json", b"x", "application/json")
        .unwrap();
    state.log.lock().unwrap().clear();
    let keys = store.list("builtins/tsc/").unwrap();
    assert_eq!(
        keys,
        [
            "builtins/tsc/7.1.3.json",
            "builtins/tsc/7.1.4.json",
            "builtins/tsc/7.2.0.json",
            "builtins/tsc/7.3.0.json",
            "builtins/tsc/8.0.0.json",
        ]
    );
    let log = state.log.lock().unwrap().clone();
    assert_eq!(log.len(), 3, "{log:?}");
    assert!(
        log[1].contains("continuation-token=t%2F%2B2%3D%3D"),
        "{log:?}"
    );
    assert_eq!(state.bad_signatures.load(Ordering::SeqCst), 0);
}

#[test]
fn retries_server_errors_then_gives_up() {
    let (state, endpoint) = serve();
    let store = R2Store::with_endpoint(&endpoint, BUCKET, creds(), fast_options(1000)).unwrap();
    store.put("a/b", b"x", "text/plain").unwrap();

    state.fail_next.store(2, Ordering::SeqCst);
    assert_eq!(store.get("a/b").unwrap().unwrap(), b"x");

    state.fail_next.store(3, Ordering::SeqCst);
    let err = store.get("a/b").unwrap_err();
    assert!(
        matches!(&err, StoreError::Http { status: 503, code: Some(c), .. } if c == "ServiceUnavailable"),
        "{err}"
    );
}

#[test]
fn wrong_secret_is_a_clear_error_and_never_printed() {
    let (state, endpoint) = serve();
    let wrong = Credentials::new("test-key-id", "super-secret-value");
    let store = R2Store::with_endpoint(&endpoint, BUCKET, wrong, fast_options(1000)).unwrap();
    let err = store.get("a/b").unwrap_err();
    assert!(
        matches!(&err, StoreError::Http { status: 403, code: Some(c), .. } if c == "SignatureDoesNotMatch"),
        "{err}"
    );
    assert_eq!(state.bad_signatures.load(Ordering::SeqCst), 1);
    let printed = format!("{err} {err:?} {store:?}");
    assert!(!printed.contains("super-secret-value"), "{printed}");
    assert!(!printed.contains("test-key-id"), "{printed}");
}

#[test]
fn transport_failures_are_retried_then_reported() {
    // Bind and drop, so the port refuses connections.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let store = R2Store::with_endpoint(
        &format!("http://127.0.0.1:{port}"),
        BUCKET,
        creds(),
        fast_options(1000),
    )
    .unwrap();
    assert!(matches!(
        store.get("a/b"),
        Err(StoreError::Transport { .. })
    ));
}

#[test]
fn addressing_and_configuration() {
    let path = R2Store::new("0123456789abcdef0123456789abcdef", BUCKET, creds()).unwrap();
    let (host, p) = path.locate(Some("blobs/sha256/ab"));
    assert_eq!(
        host,
        "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
    );
    assert_eq!(p, "/ci-bucket/blobs/sha256/ab");
    assert_eq!(path.locate(None).1, "/ci-bucket");

    let vhost = R2Store::with_endpoint(
        "https://acct.eu.r2.cloudflarestorage.com:443/",
        BUCKET,
        creds(),
        R2Options {
            url_style: UrlStyle::VirtualHost,
            ..R2Options::default()
        },
    )
    .unwrap();
    let (host, p) = vhost.locate(Some("a/b"));
    assert_eq!(host, "ci-bucket.acct.eu.r2.cloudflarestorage.com");
    assert_eq!(p, "/a/b");
    assert_eq!(vhost.locate(None).1, "/");
    assert_eq!(
        vhost.url(&host, &p, "x=1"),
        "https://ci-bucket.acct.eu.r2.cloudflarestorage.com/a/b?x=1"
    );

    for bad in [
        "http://example.com",
        "ftp://x",
        "https://user:pw@host",
        "https://host/path",
        "https://host:99999",
    ] {
        assert!(
            R2Store::with_endpoint(bad, BUCKET, creds(), R2Options::default()).is_err(),
            "{bad}"
        );
    }
    for bad in ["ab", "Upper", "-lead", "trail-", "under_score", "dot.ted"] {
        assert!(R2Store::new("acct", bad, creds()).is_err(), "{bad}");
    }
    assert!(R2Store::new("acct.evil.com", BUCKET, creds()).is_err());
    assert!(R2Store::new("", BUCKET, creds()).is_err());
}

#[test]
fn credentials_debug_is_redacted() {
    let c = Credentials::new("AKIDEXAMPLE", "s3cr3t");
    let shown = format!("{c:?}");
    assert!(
        !shown.contains("AKIDEXAMPLE") && !shown.contains("s3cr3t"),
        "{shown}"
    );
}

#[test]
fn backoff_is_bounded_and_grows() {
    let p = RetryPolicy {
        max_attempts: 10,
        base_delay: Duration::from_millis(100),
        max_delay: Duration::from_secs(1),
    };
    for retry in 1..10 {
        let d = p.delay(retry);
        let cap = (Duration::from_millis(100) * (1 << (retry - 1))).min(Duration::from_secs(1));
        assert!(d >= cap / 2 && d <= cap, "retry {retry}: {d:?}");
    }
}
