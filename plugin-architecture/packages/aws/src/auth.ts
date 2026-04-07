/**
 * AWS Signature Version 4 — pure Web Crypto implementation.
 * Signs requests for any AWS service without the AWS SDK.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

interface SignRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  service: string;
  credentials: AwsCredentials;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(hash);
}

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

// ─── Signing key derivation ─────────────────────────────────────────────────

async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(
    new TextEncoder().encode(`AWS4${secretKey}`),
    dateStamp,
  );
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// ─── Public: sign a request ─────────────────────────────────────────────────

export async function signRequest(req: SignRequest): Promise<Record<string, string>> {
  const { method, url: rawUrl, headers, body, service, credentials } = req;
  const { accessKeyId, secretAccessKey, region } = credentials;
  const { amzDate, dateStamp } = getAmzDate();

  const parsedUrl = new URL(rawUrl);
  const canonicalUri = parsedUrl.pathname || "/";

  // Sort query params
  const params = [...parsedUrl.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const canonicalQueryString = params
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join("&");

  // Headers to sign — must include host and x-amz-date at minimum
  const signedHeaders: Record<string, string> = {
    host: parsedUrl.host,
    "x-amz-date": amzDate,
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${signedHeaders[k]!.trim()}`)
    .join("\n") + "\n";
  const signedHeadersStr = sortedHeaderKeys.join(";");

  const payloadHash = await sha256(body ?? "");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  return {
    ...headers,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: authorization,
  };
}

/**
 * Parse an XML response from AWS Query APIs (EC2, RDS, IAM, etc.)
 * into a plain object tree. Uses DOMParser (available in Electron/browser).
 */
export function parseXml(xml: string): Record<string, unknown> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  return elementToObject(doc.documentElement!);
}

function elementToObject(el: Element): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const child of el.children) {
    const key = child.localName;
    // If multiple children share the same tag, collect as array
    if (obj[key] !== undefined) {
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      (obj[key] as unknown[]).push(
        child.children.length > 0 ? elementToObject(child) : child.textContent ?? "",
      );
    } else if (child.localName === "item" || child.localName === "member") {
      // AWS uses <item> or <member> for list elements — wrap parent as array
      if (!Array.isArray(obj[key])) obj[key] = [];
      (obj[key] as unknown[]).push(
        child.children.length > 0 ? elementToObject(child) : child.textContent ?? "",
      );
    } else {
      obj[key] = child.children.length > 0 ? elementToObject(child) : child.textContent ?? "";
    }
  }
  return obj;
}

/**
 * Flatten AWS XML list structures.
 * AWS wraps lists as: <instancesSet><item>...</item><item>...</item></instancesSet>
 * This helper ensures the result is always an array.
 */
export function ensureArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}
