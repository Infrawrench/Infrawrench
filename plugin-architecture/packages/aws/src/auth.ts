/**
 * AWS credentials shape + a handful of compat helpers retained for
 * existing call sites. SigV4 signing and XML parsing now live in
 * `signed-request.ts` and `xml.ts` respectively — backed by
 * `@smithy/signature-v4` and `fast-xml-parser`, so this module no
 * longer relies on DOMParser or hand-rolled HMAC.
 */

export { parseXml, ensureArray } from "./xml.js";

/**
 * Sign a custom HTTP request with SigV4. Re-exported from
 * `signed-request.ts` for backwards-compat with call sites that
 * still want to assemble their own headers; new code should call
 * the transport helpers in `client-transport.ts` instead, which
 * go through per-service AWS SDK clients.
 */
export { signRequest } from "./signed-request.js";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}
