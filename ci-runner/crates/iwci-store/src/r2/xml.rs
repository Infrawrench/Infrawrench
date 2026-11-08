//! Just enough XML for the two documents S3 sends us: a ListObjectsV2 page
//! and an error body. A full XML crate would be the larger dependency by far
//! for reading three element paths; this reader handles the prolog, comments,
//! CDATA, attributes on the root (the `xmlns`), self-closing elements and the
//! five named entities plus numeric references, and refuses anything
//! malformed rather than guessing.

use crate::error::StoreError;

/// One ListObjectsV2 page.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ListPage {
    pub keys: Vec<String>,
    /// Per key, in the same order: its `<Size>` and `<LastModified>`.
    pub sizes: Vec<Option<u64>>,
    pub modified: Vec<Option<u64>>,
    pub next_token: Option<String>,
}

/// Seconds since the epoch for an S3 timestamp such as
/// `2026-11-01T12:34:56.000Z`. `None` for anything else.
pub(crate) fn parse_timestamp(text: &str) -> Option<u64> {
    let t = text.trim();
    let num = |s: &str| s.parse::<i64>().ok();
    let (y, mo, d) = (num(t.get(0..4)?)?, num(t.get(5..7)?)?, num(t.get(8..10)?)?);
    let (h, mi, s) = (
        num(t.get(11..13)?)?,
        num(t.get(14..16)?)?,
        num(t.get(17..19)?)?,
    );
    if t.get(4..5)? != "-" || t.get(10..11)? != "T" || !t.ends_with('Z') {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + s).ok()
}

fn bad(what: impl Into<String>) -> StoreError {
    StoreError::InvalidResponse { what: what.into() }
}

fn decode_entities(raw: &str) -> Result<String, StoreError> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let end = after
            .find(';')
            .ok_or_else(|| bad("unterminated XML entity"))?;
        let name = &after[..end];
        let ch = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = name.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16).ok()
                } else if let Some(dec) = name.strip_prefix('#') {
                    dec.parse().ok()
                } else {
                    None
                };
                code.and_then(char::from_u32)
                    .ok_or_else(|| bad(format!("unknown XML entity &{name};")))?
            }
        };
        out.push(ch);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Walks the document and calls `on_text(path, text)` for each element's
/// text content, where `path` is the stack of local names from the root.
fn walk(doc: &str, mut on_text: impl FnMut(&[&str], String)) -> Result<(), StoreError> {
    let mut stack: Vec<&str> = Vec::new();
    let mut text = String::new();
    let mut rest = doc;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            if !rest.trim().is_empty() && stack.is_empty() {
                return Err(bad("text outside the XML root"));
            }
            text.push_str(&decode_entities(rest)?);
            break;
        };
        text.push_str(&decode_entities(&rest[..lt])?);
        rest = &rest[lt..];
        if let Some(r) = rest.strip_prefix("<?") {
            let end = r
                .find("?>")
                .ok_or_else(|| bad("unterminated XML declaration"))?;
            rest = &r[end + 2..];
        } else if let Some(r) = rest.strip_prefix("<!--") {
            let end = r
                .find("-->")
                .ok_or_else(|| bad("unterminated XML comment"))?;
            rest = &r[end + 3..];
        } else if let Some(r) = rest.strip_prefix("<![CDATA[") {
            let end = r.find("]]>").ok_or_else(|| bad("unterminated CDATA"))?;
            text.push_str(&r[..end]);
            rest = &r[end + 3..];
        } else if rest.starts_with("<!") {
            return Err(bad("XML doctype declarations are not accepted"));
        } else if let Some(r) = rest.strip_prefix("</") {
            let end = r.find('>').ok_or_else(|| bad("unterminated XML tag"))?;
            let name = r[..end].trim();
            match stack.last() {
                Some(open) if *open == local_name(name) => {}
                _ => return Err(bad(format!("mismatched XML end tag </{name}>"))),
            }
            on_text(&stack, std::mem::take(&mut text));
            stack.pop();
            rest = &r[end + 1..];
        } else {
            let r = &rest[1..];
            let end = r.find('>').ok_or_else(|| bad("unterminated XML tag"))?;
            let inner = &r[..end];
            let self_closing = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let name = inner
                .split(|c: char| c.is_ascii_whitespace())
                .next()
                .unwrap_or("");
            if name.is_empty() {
                return Err(bad("empty XML tag"));
            }
            text.clear();
            stack.push(local_name(name));
            if self_closing {
                on_text(&stack, String::new());
                stack.pop();
            }
            rest = &r[end + 1..];
        }
    }
    if !stack.is_empty() {
        return Err(bad("truncated XML document"));
    }
    Ok(())
}

fn local_name(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// Decodes `encoding-type=url` values. S3 encodes like HTML forms (space as
/// `+`), so `+` is decoded first; keys in this bucket never contain either.
fn url_decode(value: &str) -> Result<String, StoreError> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = value
                    .get(i + 1..i + 3)
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                    .ok_or_else(|| bad("bad percent-encoding in listed key"))?;
                out.push(hex);
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8(out).map_err(|_| bad("listed key is not UTF-8"))
}

/// Parses a `ListBucketResult`.
pub(crate) fn parse_list(doc: &str) -> Result<ListPage, StoreError> {
    let mut root = None;
    let mut raw_keys = Vec::new();
    let mut sizes: Vec<Option<u64>> = Vec::new();
    let mut modified: Vec<Option<u64>> = Vec::new();
    let mut truncated = None;
    let mut token = None;
    let mut encoding = None;
    walk(doc, |path, text| {
        if root.is_none() {
            root = path.first().map(|s| s.to_string());
        }
        match path {
            ["ListBucketResult", "Contents", "Key"] => {
                raw_keys.push(text);
                sizes.push(None);
                modified.push(None);
            }
            ["ListBucketResult", "Contents", "Size"] => {
                if let Some(last) = sizes.last_mut() {
                    *last = text.trim().parse().ok();
                }
            }
            ["ListBucketResult", "Contents", "LastModified"] => {
                if let Some(last) = modified.last_mut() {
                    *last = parse_timestamp(&text);
                }
            }
            ["ListBucketResult", "IsTruncated"] => truncated = Some(text),
            ["ListBucketResult", "NextContinuationToken"] => token = Some(text),
            ["ListBucketResult", "EncodingType"] => encoding = Some(text),
            _ => {}
        }
    })?;
    if root.as_deref() != Some("ListBucketResult") {
        return Err(bad("listing response is not a ListBucketResult"));
    }
    let keys = if encoding.as_deref() == Some("url") {
        raw_keys
            .iter()
            .map(|k| url_decode(k))
            .collect::<Result<_, _>>()?
    } else {
        raw_keys
    };
    let next_token = match truncated.as_deref().map(str::trim) {
        Some("true") => match token {
            Some(t) if !t.is_empty() => Some(t),
            // Without a token a truncated listing would silently end early,
            // hiding versions; that is an error, not the end of the list.
            _ => return Err(bad("truncated listing without a NextContinuationToken")),
        },
        Some("false") | None => None,
        Some(other) => return Err(bad(format!("IsTruncated is {other:?}"))),
    };
    Ok(ListPage {
        keys,
        sizes,
        modified,
        next_token,
    })
}

/// The `<Code>` of an S3 `<Error>` body, if the body is one.
pub(crate) fn error_code(doc: &str) -> Option<String> {
    let mut code = None;
    walk(doc, |path, text| {
        if path == ["Error", "Code"] {
            code = Some(text.trim().to_owned());
        }
    })
    .ok()?;
    code.filter(|c| !c.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_and_sizes_come_with_their_keys() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_timestamp("2026-11-01T00:00:00.000Z"),
            Some(1_793_491_200)
        );
        assert_eq!(parse_timestamp("2026-11-01 00:00:00"), None);
        let page = parse_list(PAGE_1).unwrap();
        assert_eq!(page.sizes.len(), page.keys.len());
        assert_eq!(page.sizes[0], Some(300));
        assert_eq!(page.modified[0], Some(1_793_491_200));
        assert_eq!(page.modified[1], None);
    }

    const PAGE_1: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>ci</Name><Prefix>builtins%2Ftsc%2F</Prefix><KeyCount>2</KeyCount>
  <MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated><EncodingType>url</EncodingType>
  <ContinuationToken/>
  <Contents>
    <Key>builtins%2Ftsc%2F7.0.0.json</Key><LastModified>2026-11-01T00:00:00.000Z</LastModified>
    <ETag>&quot;abc&quot;</ETag><Size>300</Size><StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents><Key>builtins/tsc/7.1.0.json</Key><Size>301</Size></Contents>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
</ListBucketResult>"#;

    const PAGE_2: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>ci</Name>
<Prefix>builtins/tsc/</Prefix><KeyCount>1</KeyCount><MaxKeys>2</MaxKeys>
<IsTruncated>false</IsTruncated>
<Contents><Key><![CDATA[builtins/tsc/7.1.3.json]]></Key><Size>302</Size></Contents>
<!-- no token on the last page -->
</ListBucketResult>"#;

    #[test]
    fn parses_paginated_listing() {
        let p1 = parse_list(PAGE_1).unwrap();
        assert_eq!(
            p1.keys,
            ["builtins/tsc/7.0.0.json", "builtins/tsc/7.1.0.json"]
        );
        assert_eq!(
            p1.next_token.as_deref(),
            Some("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=")
        );
        let p2 = parse_list(PAGE_2).unwrap();
        assert_eq!(p2.keys, ["builtins/tsc/7.1.3.json"]);
        assert_eq!(p2.next_token, None);
    }

    #[test]
    fn empty_and_entity_listing() {
        let empty = r#"<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>"#;
        assert_eq!(parse_list(empty).unwrap(), ListPage::default());
        let ent = r#"<ListBucketResult><Contents><Key>a&amp;b&#x2F;c&#47;d</Key></Contents></ListBucketResult>"#;
        assert_eq!(parse_list(ent).unwrap().keys, ["a&b/c/d"]);
    }

    #[test]
    fn refuses_malformed_listings() {
        for doc in [
            "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
            "<ListBucketResult><IsTruncated>yes</IsTruncated></ListBucketResult>",
            "<ListBucketResult><Contents><Key>a</Contents></ListBucketResult>",
            "<ListBucketResult><Contents><Key>a</Key></Contents>",
            "<Error><Code>AccessDenied</Code></Error>",
            "<!DOCTYPE x [<!ENTITY a 'b'>]><ListBucketResult/>",
            "<ListBucketResult><Contents><Key>&bogus;</Key></Contents></ListBucketResult>",
            "<ListBucketResult><EncodingType>url</EncodingType><Contents><Key>%zz</Key></Contents></ListBucketResult>",
        ] {
            assert!(parse_list(doc).is_err(), "{doc}");
        }
    }

    #[test]
    fn error_codes() {
        let doc = r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>"#;
        assert_eq!(error_code(doc).as_deref(), Some("NoSuchKey"));
        assert_eq!(error_code("not xml <"), None);
        assert_eq!(error_code(""), None);
    }
}
