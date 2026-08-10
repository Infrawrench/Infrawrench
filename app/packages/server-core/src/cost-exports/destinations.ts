/**
 * Where a cost export run writes.
 *
 * Two sinks, both fed by an async iterable of strings and both bounded in
 * memory. The contract is deliberately narrow — {@link uploadCostExportObject}
 * takes a body stream and a key, and returns the byte count — because the run
 * loop should not know how many HTTP requests a destination needed.
 *
 * **S3-compatible** covers AWS S3, Cloudflare R2, DigitalOcean Spaces,
 * Scaleway, Backblaze B2 and MinIO in one implementation: they differ only in
 * endpoint, region and whether the bucket is a subdomain or a path segment, and
 * all of them speak SigV4. Signing goes through `signedS3Fetch` in
 * `@infrawrench/plugin-base` — the same signer the AWS, Spaces and Scaleway
 * plugins use. A fourth copy of a security primitive is not something to add
 * for a feature.
 *
 * A small object goes out as a single `PUT`. Anything larger becomes a
 * multipart upload with {@link PART_SIZE} parts, which is what keeps a year of
 * per-resource rows off the heap: the run holds one part at a time, uploads it,
 * and drops it. The alternative — buffering the object to size it for a single
 * `PUT`'s `Content-Length` — is exactly the OOM this feature has to avoid.
 *
 * **HTTPS** posts the body as a streamed request. The URL is treated as a
 * bearer credential (a pre-signed URL carries its own signature), so it is
 * stored encrypted, never returned, and sent byte-for-byte as stored — see
 * {@link uploadToHttp} for why nothing may be appended to its query string.
 */
import { Readable } from "node:stream";
import { signedS3Fetch } from "@infrawrench/plugin-base";
import type { CostExportDestination } from "@infrawrench/client-core";
import type { CostExportCredentials } from "./store";

/**
 * 8 MiB. Above S3's 5 MiB multipart minimum with headroom, and small enough
 * that a run's steady-state memory is a rounding error next to the poller.
 * S3 allows 10,000 parts, so this caps one object at 80 GiB — orders of
 * magnitude beyond any org's daily cost rows.
 */
export const PART_SIZE = 8 * 1024 * 1024;

/** Objects are switched to multipart the moment they exceed one part. */
const SINGLE_PUT_LIMIT = PART_SIZE;

export class CostExportUploadError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "CostExportUploadError";
  }
}

/** Non-secret provenance attached to the object itself, alongside the rows. */
export interface ObjectStamp {
  periodStart: string;
  from: string;
  to: string;
  exportedAt: string;
  collectionWatermark: string;
}

export interface UploadRequest {
  destination: CostExportDestination;
  credentials: CostExportCredentials;
  key: string;
  contentType: string;
  body: AsyncIterable<string>;
  stamp: ObjectStamp;
}

export interface UploadResult {
  byteCount: number;
}

/**
 * Metadata headers, in each transport's spelling. Object metadata is a
 * convenience for an operator poking at the bucket — the authoritative copy of
 * the same facts is in the rows, because metadata does not survive most load
 * paths (see `serialize.ts`).
 */
function stampHeaders(stamp: ObjectStamp, prefix: string): Record<string, string> {
  return {
    [`${prefix}period-start`]: stamp.periodStart,
    [`${prefix}period-from`]: stamp.from,
    [`${prefix}period-to`]: stamp.to,
    [`${prefix}exported-at`]: stamp.exportedAt,
    [`${prefix}collection-watermark`]: stamp.collectionWatermark,
  };
}

/**
 * Re-chunk a string stream into byte buffers of at most `size`.
 *
 * The last chunk is whatever is left and may be short — which is legal for the
 * final part of a multipart upload and for a single PUT, and is the only place
 * a short chunk is produced.
 */
async function* chunked(
  body: AsyncIterable<string>,
  size: number,
): AsyncGenerator<Buffer, void, undefined> {
  let held: Buffer[] = [];
  let heldBytes = 0;
  for await (const piece of body) {
    const buf = Buffer.from(piece, "utf8");
    held.push(buf);
    heldBytes += buf.byteLength;
    while (heldBytes >= size) {
      const joined = Buffer.concat(held, heldBytes);
      yield joined.subarray(0, size);
      const rest = joined.subarray(size);
      held = rest.byteLength > 0 ? [rest] : [];
      heldBytes = rest.byteLength;
    }
  }
  if (heldBytes > 0) yield Buffer.concat(held, heldBytes);
}

/** Origin for an S3-compatible endpoint, defaulting to AWS S3 for the region. */
function s3Origin(dest: Extract<CostExportDestination, { kind: "s3" }>): string {
  const explicit = dest.endpoint.trim().replace(/\/+$/, "");
  if (explicit) return explicit.includes("://") ? explicit : `https://${explicit}`;
  return `https://s3.${dest.region}.amazonaws.com`;
}

/** Full object URL, honouring virtual-hosted vs path-style addressing. */
function s3ObjectUrl(
  dest: Extract<CostExportDestination, { kind: "s3" }>,
  key: string,
  query = "",
): string {
  const origin = s3Origin(dest);
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = new URL(origin);
  if (dest.forcePathStyle) {
    url.pathname = `/${dest.bucket}/${encodedKey}`;
  } else {
    url.hostname = `${dest.bucket}.${url.hostname}`;
    url.pathname = `/${encodedKey}`;
  }
  return `${url.toString()}${query}`;
}

/** First capture of a tag, without pulling in an XML parser for two fields. */
function xmlTag(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match?.[1]?.trim() ?? null;
}

async function failure(res: Response, what: string): Promise<CostExportUploadError> {
  const text = await res.text().catch(() => "");
  // S3 error bodies are XML with a human-readable <Message>; surfacing that
  // verbatim is the difference between "403" and "the key has no s3:PutObject
  // on this prefix", which is what the settings UI has to show.
  const message = xmlTag(text, "Message") ?? text.slice(0, 400);
  return new CostExportUploadError(
    `${what} failed (${res.status})${message ? `: ${message}` : ""}`,
    res.status,
  );
}

async function uploadToS3(req: UploadRequest): Promise<UploadResult> {
  const dest = req.destination as Extract<CostExportDestination, { kind: "s3" }>;
  const creds = req.credentials;
  if (creds.kind !== "s3") {
    throw new CostExportUploadError("No S3 credentials are stored for this export");
  }
  const sign = {
    accessKey: creds.accessKeyId,
    secretKey: creds.secretAccessKey,
    region: dest.region || "us-east-1",
  };
  const meta = stampHeaders(req.stamp, "x-amz-meta-infrawrench-");

  const parts = chunked(req.body, PART_SIZE);
  const first = await parts.next();
  const firstChunk = first.done ? Buffer.alloc(0) : first.value;

  // Common case: the whole object fits in one part, so skip multipart entirely.
  // A three-request handshake for a 40 KB file is latency nobody is buying.
  if (firstChunk.byteLength <= SINGLE_PUT_LIMIT) {
    const peek = await parts.next();
    if (peek.done) {
      const res = await signedS3Fetch({
        ...sign,
        method: "PUT",
        url: s3ObjectUrl(dest, req.key),
        headers: { "content-type": req.contentType, ...meta },
        body: firstChunk,
      });
      if (!res.ok) throw await failure(res, "S3 PUT");
      return { byteCount: firstChunk.byteLength };
    }
    // Two parts already: fall through to multipart, replaying what we hold.
    return await multipartUpload(dest, sign, req, meta, [firstChunk, peek.value], parts);
  }

  return await multipartUpload(dest, sign, req, meta, [firstChunk], parts);
}

async function multipartUpload(
  dest: Extract<CostExportDestination, { kind: "s3" }>,
  sign: { accessKey: string; secretKey: string; region: string },
  req: UploadRequest,
  meta: Record<string, string>,
  pending: Buffer[],
  rest: AsyncGenerator<Buffer, void, undefined>,
): Promise<UploadResult> {
  const createRes = await signedS3Fetch({
    ...sign,
    method: "POST",
    url: s3ObjectUrl(dest, req.key, "?uploads="),
    headers: { "content-type": req.contentType, ...meta },
  });
  if (!createRes.ok) throw await failure(createRes, "S3 CreateMultipartUpload");
  const uploadId = xmlTag(await createRes.text(), "UploadId");
  if (!uploadId) {
    throw new CostExportUploadError("S3 CreateMultipartUpload returned no UploadId");
  }

  const etags: string[] = [];
  let byteCount = 0;
  try {
    const send = async (chunk: Buffer): Promise<void> => {
      const partNumber = etags.length + 1;
      const res = await signedS3Fetch({
        ...sign,
        method: "PUT",
        url: s3ObjectUrl(
          dest,
          req.key,
          `?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
        ),
        body: chunk,
      });
      if (!res.ok) throw await failure(res, `S3 UploadPart ${partNumber}`);
      const etag = res.headers.get("etag");
      if (!etag) {
        throw new CostExportUploadError(`S3 UploadPart ${partNumber} returned no ETag`);
      }
      etags.push(etag);
      byteCount += chunk.byteLength;
    };

    for (const chunk of pending) await send(chunk);
    for await (const chunk of rest) await send(chunk);

    const xml = `<CompleteMultipartUpload>${etags
      .map(
        (etag, i) =>
          `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag.replace(/"/g, "&quot;")}</ETag></Part>`,
      )
      .join("")}</CompleteMultipartUpload>`;
    const completeRes = await signedS3Fetch({
      ...sign,
      method: "POST",
      url: s3ObjectUrl(dest, req.key, `?uploadId=${encodeURIComponent(uploadId)}`),
      headers: { "content-type": "application/xml" },
      body: xml,
    });
    if (!completeRes.ok) throw await failure(completeRes, "S3 CompleteMultipartUpload");
    // S3 answers 200 with an error document for some Complete failures — the
    // status alone is not the outcome.
    const completeBody = await completeRes.text();
    if (xmlTag(completeBody, "Error") !== null || completeBody.includes("<Error>")) {
      throw new CostExportUploadError(
        `S3 CompleteMultipartUpload failed: ${xmlTag(completeBody, "Message") ?? "unknown error"}`,
      );
    }
    return { byteCount };
  } catch (e) {
    // An abandoned multipart upload is billable storage forever on most
    // providers, so abort before rethrowing. The abort's own failure is
    // swallowed: the caller needs the original error, not this one.
    await signedS3Fetch({
      ...sign,
      method: "DELETE",
      url: s3ObjectUrl(dest, req.key, `?uploadId=${encodeURIComponent(uploadId)}`),
    }).catch(() => {});
    throw e;
  }
}

async function uploadToHttp(req: UploadRequest): Promise<UploadResult> {
  const dest = req.destination as Extract<CostExportDestination, { kind: "http" }>;
  const creds = req.credentials;
  if (creds.kind !== "http") {
    throw new CostExportUploadError("No destination URL is stored for this export");
  }

  let byteCount = 0;
  const source = Readable.from(
    (async function* () {
      for await (const piece of req.body) {
        const buf = Buffer.from(piece, "utf8");
        byteCount += buf.byteLength;
        yield buf;
      }
    })(),
  );

  const init = {
    method: dest.method === "PUT" ? "PUT" : "POST",
    headers: {
      "content-type": req.contentType,
      "x-infrawrench-object-key": req.key,
      ...stampHeaders(req.stamp, "x-infrawrench-"),
    },
    body: Readable.toWeb(source),
    // Required by undici whenever the body is a stream: the request body is
    // still being written while the response is read. Not in the DOM typings
    // this package compiles against, hence the assertion.
    duplex: "half",
  } as unknown as Parameters<typeof fetch>[1];

  // The stored URL is sent exactly as it was given to us — nothing is appended
  // to its query string, and it is not even round-tripped through `new URL`.
  //
  // The object key travels in `x-infrawrench-object-key` (and its period in the
  // stamp headers), which is everything a receiver needs to route on. A `?key=`
  // parameter would be a second copy of that same fact, bought by mutating a
  // URL we do not own — and a pre-signed URL signs its query string, so one
  // extra parameter turns every single upload into a rejection: `X-Amz-Signature`
  // (S3/R2/Spaces), `X-Goog-Signature` (GCS), `sig` (an Azure SAS), or whatever
  // opaque `token=` an ingest endpoint issues.
  //
  // Detecting those parameter names instead was considered and rejected. The
  // set of signature spellings is open-ended, so a blocklist is wrong exactly
  // in the case that matters — a destination nobody here has seen — and the
  // failure it produces is a silent, total upload outage on a nightly job.
  // Even for an unsigned URL, quietly overwriting a `key` parameter the user
  // deliberately put in their endpoint is a surprise nobody debugs quickly.
  // Never append to this URL.
  const res = await fetch(creds.url, init);

  if (!res.ok) throw await failure(res, `HTTP ${dest.method}`);
  await res.body?.cancel().catch(() => {});
  return { byteCount };
}

/** Write one object to the export's destination. Throws {@link CostExportUploadError}. */
export async function uploadCostExportObject(req: UploadRequest): Promise<UploadResult> {
  return req.destination.kind === "s3" ? await uploadToS3(req) : await uploadToHttp(req);
}
