//! AWS Signature Version 4, header form, for the S3 service.
//!
//! Hand-rolled instead of `rusty-s3` because `rusty-s3` 0.11 only produces
//! presigned (query-string) URLs, and Cloudflare documents presigned URLs on
//! R2 for GET, HEAD, PUT and DELETE of single objects only, not for
//! ListObjectsV2. Header signing is what every AWS SDK sends for every
//! operation, it keeps a bearer-usable signature out of every URL we might
//! print, and it is about a hundred lines over `hmac` and `sha2`, which the
//! workspace already builds. The output is checked against the AWS S3 example
//! vectors and against botocore in the tests below.

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{KeyInit as _, Mac as _};
use sha2::{Digest as _, Sha256};

use super::Credentials;

/// SHA-256 of the empty string, the payload hash of every bodiless request.
pub(crate) const EMPTY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// A request timestamp, as `YYYYMMDD'T'HHMMSS'Z'`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AmzDate(pub(crate) String);

impl AmzDate {
    pub(crate) fn now() -> Self {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        Self::from_unix(secs)
    }

    pub(crate) fn from_unix(secs: u64) -> Self {
        let days = (secs / 86_400) as i64;
        let rem = secs % 86_400;
        let (y, m, d) = civil_from_days(days);
        Self(format!(
            "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        ))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    fn date(&self) -> &str {
        &self.0[..8]
    }
}

/// Days since 1970-01-01 to a proleptic Gregorian date. Howard Hinnant's
/// `civil_from_days`, which avoids a date crate for one format string.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Percent-encodes per SigV4: every byte except `A-Za-z0-9-_.~`, and `/` too
/// when `keep_slash` is set (S3 object paths are not double-encoded).
pub(crate) fn uri_encode(input: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'~')
            || (keep_slash && b == b'/')
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The query string, encoded and sorted the way SigV4 canonicalises it. The
/// request is sent with exactly this string, so what is signed is what goes
/// on the wire.
pub(crate) fn canonical_query(params: &[(&str, &str)]) -> String {
    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (uri_encode(k, false), uri_encode(v, false)))
        .collect();
    encoded.sort();
    encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// What to sign.
pub(crate) struct Request<'a> {
    pub method: &'a str,
    /// The `Host` header value, with `:port` when the port is not the
    /// scheme's default (that is what HTTP clients send).
    pub host: &'a str,
    /// Already-encoded absolute path, such as `/bucket/blobs/sha256/ab`.
    pub path: &'a str,
    /// Output of [`canonical_query`].
    pub query: &'a str,
    /// Extra headers to sign, besides host and the two `x-amz-` ones.
    pub headers: &'a [(&'a str, &'a str)],
    /// Lowercase hex SHA-256 of the body.
    pub payload_sha256: &'a str,
}

/// The signature and the headers that must accompany it.
#[derive(Debug)]
pub(crate) struct Signed {
    pub authorization: String,
    pub amz_date: String,
    pub content_sha256: String,
    #[cfg_attr(not(test), allow(dead_code))]
    pub canonical_request: String,
    #[cfg_attr(not(test), allow(dead_code))]
    pub string_to_sign: String,
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

fn canonical_value(v: &str) -> String {
    // Trim and collapse runs of spaces, as the spec asks.
    v.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn sign(creds: &Credentials, region: &str, date: &AmzDate, req: &Request<'_>) -> Signed {
    let mut headers: Vec<(String, String)> = vec![
        ("host".into(), canonical_value(req.host)),
        ("x-amz-content-sha256".into(), req.payload_sha256.into()),
        ("x-amz-date".into(), date.as_str().into()),
    ];
    headers.extend(
        req.headers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), canonical_value(v))),
    );
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        req.method, req.path, req.query, req.payload_sha256
    );
    let scope = format!("{}/{region}/s3/aws4_request", date.date());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        date.as_str(),
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let k_date = hmac(
        format!("AWS4{}", creds.secret()).as_bytes(),
        date.date().as_bytes(),
    );
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));
    Signed {
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            creds.access_key_id()
        ),
        amz_date: date.as_str().to_owned(),
        content_sha256: req.payload_sha256.to_owned(),
        canonical_request,
        string_to_sign,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_creds() -> Credentials {
        Credentials::new(
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        )
    }

    /// 2013-05-24T00:00:00Z, the date of the AWS examples.
    fn example_date() -> AmzDate {
        AmzDate::from_unix(1_369_353_600)
    }

    #[test]
    fn dates() {
        assert_eq!(example_date().as_str(), "20130524T000000Z");
        assert_eq!(AmzDate::from_unix(0).as_str(), "19700101T000000Z");
        // A leap day and a time of day.
        assert_eq!(
            AmzDate::from_unix(1_709_210_096).as_str(),
            "20240229T123456Z"
        );
        assert_eq!(
            AmzDate::from_unix(1_794_139_200).as_str(),
            "20261108T120000Z"
        );
    }

    /// The "GET Object" example from the S3 SigV4 header-auth documentation
    /// (also reproduced by botocore's `S3SigV4Auth`).
    #[test]
    fn aws_get_object_vector() {
        let s = sign(
            &example_creds(),
            "us-east-1",
            &example_date(),
            &Request {
                method: "GET",
                host: "examplebucket.s3.amazonaws.com",
                path: "/test.txt",
                query: "",
                headers: &[("Range", "bytes=0-9")],
                payload_sha256: EMPTY_SHA256,
            },
        );
        assert_eq!(
            s.canonical_request,
            "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n\
             x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\
             x-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n\
             e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            s.string_to_sign,
            "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n\
             7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"
        );
        assert_eq!(
            s.authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    /// The "GET Bucket (List Objects)" example: exercises query
    /// canonicalisation.
    #[test]
    fn aws_list_objects_vector() {
        let query = canonical_query(&[("prefix", "J"), ("max-keys", "2")]);
        assert_eq!(query, "max-keys=2&prefix=J");
        let s = sign(
            &example_creds(),
            "us-east-1",
            &example_date(),
            &Request {
                method: "GET",
                host: "examplebucket.s3.amazonaws.com",
                path: "/",
                query: &query,
                headers: &[],
                payload_sha256: EMPTY_SHA256,
            },
        );
        assert!(s.authorization.ends_with(
            "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        ));
    }

    /// R2-shaped requests (region `auto`, path style, a continuation token
    /// that needs encoding, a signed body), with signatures computed by
    /// botocore 2.31's `S3SigV4Auth` at 2026-11-08T12:00:00Z.
    #[test]
    fn botocore_r2_vectors() {
        let date = AmzDate::from_unix(1_794_139_200);
        let query = canonical_query(&[
            ("list-type", "2"),
            ("prefix", "builtins/tsc/"),
            ("encoding-type", "url"),
            ("continuation-token", "1/ab+c=="),
        ]);
        assert_eq!(
            query,
            "continuation-token=1%2Fab%2Bc%3D%3D&encoding-type=url&list-type=2&prefix=builtins%2Ftsc%2F"
        );
        let list = sign(
            &example_creds(),
            "auto",
            &date,
            &Request {
                method: "GET",
                host: "acct.r2.cloudflarestorage.com",
                path: "/ci-bucket",
                query: &query,
                headers: &[],
                payload_sha256: EMPTY_SHA256,
            },
        );
        assert_eq!(
            list.authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261108/auto/s3/aws4_request, \
             SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
             Signature=b95628077e427155d4acf754f6e2b527fde565488a72aa53aa53735118d86511"
        );
        let body_hash = hex::encode(Sha256::digest(b"hello"));
        let put = sign(
            &example_creds(),
            "auto",
            &date,
            &Request {
                method: "PUT",
                host: "acct.r2.cloudflarestorage.com",
                path: "/ci-bucket/blobs/sha256/abc",
                query: "",
                headers: &[("Content-Type", "application/wasm")],
                payload_sha256: &body_hash,
            },
        );
        assert_eq!(
            put.authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261108/auto/s3/aws4_request, \
             SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, \
             Signature=7029ac6ff4aaf6d45c26b3fdb1fcd3d61c1cdfba6326e176e73f4aa3c99b0c83"
        );
    }

    #[test]
    fn encoding() {
        assert_eq!(uri_encode("a b/c~d", true), "a%20b/c~d");
        assert_eq!(uri_encode("a b/c~d", false), "a%20b%2Fc~d");
        assert_eq!(uri_encode("\u{e9}", false), "%C3%A9");
    }
}
