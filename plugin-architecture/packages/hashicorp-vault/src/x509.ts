import { base64ToBytes } from "@infrawrench/plugin-base";

/**
 * Just enough DER to read a certificate's subject common name and validity
 * window. Vault's `GET /<pki>/cert/:serial` returns only the PEM, and the PKI
 * listing returns only serials, so expiry has to come from the certificate
 * itself. No dependency: the walk follows the fixed X.509 layout
 * (Certificate → tbsCertificate → [version] serial sigAlg issuer validity
 * subject).
 */
interface Tlv {
  tag: number;
  start: number; // first content byte
  end: number; // one past the last content byte
}

function readTlv(b: Uint8Array, pos: number): Tlv {
  const tag = b[pos]!;
  let len = b[pos + 1]!;
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > b.length) throw new Error("truncated DER");
  return { tag, start, end };
}

function children(b: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.start;
  while (pos < parent.end) {
    const t = readTlv(b, pos);
    out.push(t);
    pos = t.end;
  }
  return out;
}

const text = (b: Uint8Array, t: Tlv) => new TextDecoder().decode(b.subarray(t.start, t.end));

function parseTime(b: Uint8Array, t: Tlv): string | undefined {
  const s = text(b, t);
  // UTCTime YYMMDDHHMMSSZ, GeneralizedTime YYYYMMDDHHMMSSZ
  const m =
    t.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
  if (!m) return undefined;
  let year = Number(m[1]);
  if (t.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return new Date(
    Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0")),
  ).toISOString();
}

const OID_CN = [0x55, 0x04, 0x03];

function commonName(b: Uint8Array, name: Tlv): string | undefined {
  for (const rdn of children(b, name)) {
    for (const atv of children(b, rdn)) {
      const [oid, value] = children(b, atv);
      if (!oid || !value) continue;
      const bytes = b.subarray(oid.start, oid.end);
      if (bytes.length === 3 && OID_CN.every((x, i) => bytes[i] === x)) return text(b, value);
    }
  }
  return undefined;
}

export interface CertInfo {
  commonName?: string;
  issuerCommonName?: string;
  notBefore?: string;
  notAfter?: string;
}

/** Parse the first certificate of a PEM bundle. Returns {} for anything unreadable. */
export function parsePemCertificate(pem: string): CertInfo {
  try {
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
    if (!m) return {};
    const der = base64ToBytes(m[1]!.replace(/\s+/g, ""));
    const cert = readTlv(der, 0);
    const tbs = children(der, cert)[0];
    if (!tbs) return {};
    const parts = children(der, tbs);
    let i = parts[0]?.tag === 0xa0 ? 1 : 0; // optional [0] version
    i += 2; // serialNumber, signature algorithm
    const issuer = parts[i];
    const validity = parts[i + 1];
    const subject = parts[i + 2];
    const out: CertInfo = {};
    if (validity) {
      const [nb, na] = children(der, validity);
      const notBefore = nb ? parseTime(der, nb) : undefined;
      const notAfter = na ? parseTime(der, na) : undefined;
      if (notBefore) out.notBefore = notBefore;
      if (notAfter) out.notAfter = notAfter;
    }
    const cn = subject ? commonName(der, subject) : undefined;
    if (cn) out.commonName = cn;
    const icn = issuer ? commonName(der, issuer) : undefined;
    if (icn) out.issuerCommonName = icn;
    return out;
  } catch {
    return {};
  }
}
