/**
 * AWS credentials shape. SigV4 signing and XML parsing live in
 * `signed-request.ts` and `xml.ts` respectively — backed by
 * `@smithy/signature-v4` and `fast-xml-parser`.
 */

import type { HttpHostServices } from "@infrawrench/plugin-base";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
  /**
   * Host-provided HTTP service. When set, the AWS transport routes all SigV4
   * requests through it instead of calling `fetch` directly — that's how
   * per-account bastion routing reaches AWS. The renderer/browser path also
   * uses this for CORS-free signing. Absent ⇒ direct `fetch`.
   */
  http?: HttpHostServices;
}
