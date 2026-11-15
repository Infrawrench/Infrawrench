//! The sandbox's DNS server: just enough of RFC 1035 to answer `A` and
//! `AAAA` questions, one per query, as a stub resolver asks them.
//!
//! The answers come from the job's resolver (`Outside::resolve`, then
//! `Outside::allows` again here), so a name can only ever lead to an
//! address the job may connect to; `localhost` and the job's services are
//! the loopback, as for a WASIX job.

use std::net::IpAddr;

/// A question: the query's id, the name asked for (lower case, no
/// trailing dot), its type, and the question section as sent, which the
/// answer repeats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Question {
    pub id: u16,
    pub name: String,
    pub kind: Kind,
    pub recursion_desired: bool,
    section: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    A,
    Aaaa,
    /// Anything else, answered with no records.
    Other,
}

const TYPE_A: u16 = 1;
const TYPE_AAAA: u16 = 28;
const CLASS_IN: u16 = 1;
const TTL: u32 = 60;

/// Reads a query. `None` for anything that is not one question of class
/// `IN` (the server does not answer those at all).
pub(crate) fn parse(query: &[u8]) -> Option<Question> {
    if query.len() < 12 {
        return None;
    }
    let id = u16::from_be_bytes([query[0], query[1]]);
    let flags = u16::from_be_bytes([query[2], query[3]]);
    let qdcount = u16::from_be_bytes([query[4], query[5]]);
    // A response, or not a standard query, or not exactly one question.
    if flags & 0x8000 != 0 || (flags >> 11) & 0xf != 0 || qdcount != 1 {
        return None;
    }
    let mut at = 12;
    let mut labels: Vec<String> = Vec::new();
    loop {
        let len = *query.get(at)? as usize;
        at += 1;
        if len == 0 {
            break;
        }
        // No compression in a question, and labels are at most 63 bytes.
        if len > 63 {
            return None;
        }
        let label = query.get(at..at + len)?;
        labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
        at += len;
        if at > 12 + 255 {
            return None;
        }
    }
    let qtype = u16::from_be_bytes([*query.get(at)?, *query.get(at + 1)?]);
    let qclass = u16::from_be_bytes([*query.get(at + 2)?, *query.get(at + 3)?]);
    if qclass != CLASS_IN {
        return None;
    }
    let kind = match qtype {
        TYPE_A => Kind::A,
        TYPE_AAAA => Kind::Aaaa,
        _ => Kind::Other,
    };
    Some(Question {
        id,
        name: labels.join("."),
        kind,
        recursion_desired: flags & 0x0100 != 0,
        section: query[12..at + 4].to_vec(),
    })
}

/// The answer to `q`: the addresses of its type among `addrs`, or, when
/// `exists` is false, "no such name".
pub(crate) fn answer(q: &Question, exists: bool, addrs: &[IpAddr]) -> Vec<u8> {
    let records: Vec<&IpAddr> = addrs
        .iter()
        .filter(|ip| match q.kind {
            Kind::A => ip.is_ipv4(),
            Kind::Aaaa => ip.is_ipv6(),
            Kind::Other => false,
        })
        .collect();
    let rcode: u16 = if exists { 0 } else { 3 };
    let mut flags: u16 = 0x8000 | 0x0080 | rcode; // a response; recursion available
    if q.recursion_desired {
        flags |= 0x0100;
    }
    let mut out = Vec::with_capacity(12 + q.section.len() + records.len() * 28);
    out.extend_from_slice(&q.id.to_be_bytes());
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&(records.len() as u16).to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&q.section);
    for ip in records {
        // The name is the question's, at offset 12.
        out.extend_from_slice(&0xc00cu16.to_be_bytes());
        let (kind, data): (u16, Vec<u8>) = match ip {
            IpAddr::V4(v4) => (TYPE_A, v4.octets().to_vec()),
            IpAddr::V6(v6) => (TYPE_AAAA, v6.octets().to_vec()),
        };
        out.extend_from_slice(&kind.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&TTL.to_be_bytes());
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(&data);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
        let mut q = Vec::new();
        q.extend_from_slice(&id.to_be_bytes());
        q.extend_from_slice(&0x0100u16.to_be_bytes());
        q.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]);
        for label in name.split('.').filter(|l| !l.is_empty()) {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.push(0);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&CLASS_IN.to_be_bytes());
        q
    }

    #[test]
    fn a_question_reads_back_and_is_answered_with_its_own_type() {
        let raw = query(0x1234, "Upstream.Test.", TYPE_A);
        let q = parse(&raw).unwrap();
        assert_eq!(
            (q.id, q.name.as_str(), q.kind),
            (0x1234, "upstream.test", Kind::A)
        );
        let addrs = [
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ];
        let a = answer(&q, true, &addrs);
        assert_eq!(&a[..2], &[0x12, 0x34]);
        assert_eq!(
            u16::from_be_bytes([a[2], a[3]]) & 0x800f,
            0x8000,
            "a response, no error"
        );
        assert_eq!(u16::from_be_bytes([a[6], a[7]]), 1, "only the A record");
        assert_eq!(&a[a.len() - 4..], &[203, 0, 113, 7]);
        // The same name asked for AAAA.
        let q6 = parse(&query(1, "upstream.test", TYPE_AAAA)).unwrap();
        let a6 = answer(&q6, true, &addrs);
        assert_eq!(u16::from_be_bytes([a6[6], a6[7]]), 1);
        assert_eq!(&a6[a6.len() - 16..], &Ipv6Addr::LOCALHOST.octets());
    }

    #[test]
    fn a_missing_name_is_nxdomain_and_other_types_get_no_records() {
        let q = parse(&query(7, "nowhere.test", TYPE_A)).unwrap();
        let a = answer(&q, false, &[]);
        assert_eq!(u16::from_be_bytes([a[2], a[3]]) & 0xf, 3);
        let mx = parse(&query(8, "upstream.test", 15)).unwrap();
        let a = answer(&mx, true, &[IpAddr::V4(Ipv4Addr::LOCALHOST)]);
        assert_eq!(u16::from_be_bytes([a[6], a[7]]), 0);
    }

    #[test]
    fn malformed_queries_are_not_answered() {
        assert_eq!(parse(&[0; 5]), None);
        let mut response = query(1, "a.test", TYPE_A);
        response[2] |= 0x80;
        assert_eq!(parse(&response), None);
        let mut truncated = query(1, "a.test", TYPE_A);
        truncated.truncate(truncated.len() - 3);
        assert_eq!(parse(&truncated), None);
        let mut long = query(1, "a.test", TYPE_A);
        long[12] = 64;
        assert_eq!(parse(&long), None);
        let mut pointer = query(1, "a.test", TYPE_A);
        pointer[12] = 0xc0;
        assert_eq!(parse(&pointer), None);
    }
}
