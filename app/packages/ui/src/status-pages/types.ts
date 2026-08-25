import type {
  StatusPage,
  StatusPageCreate,
  StatusPageCustomHostnameAttach,
  StatusPagePatch,
} from "@infrawrench/client-core";

export type {
  PublicStatusPage,
  StatusPage,
  StatusPageComponent,
  StatusPageComponentInput,
  StatusPageCreate,
  StatusPageCustomHostnameAttach,
  StatusPageCustomHostnameStatus,
  StatusPageHostnameVerification,
  StatusPageListResponse,
  StatusPagePatch,
} from "@infrawrench/client-core";

/**
 * Host-injected data access for the status page editor. Web wraps
 * `apiGet`/`apiPost`; desktop (cloud mode) wraps its cloud IPC — the
 * components stay platform-agnostic (the `ProbesClient` pattern).
 *
 * `appOrigin` is here rather than derived inside the component because the
 * public URL a page is reachable at is a property of the *deployment*, and
 * desktop — which renders the same editor — is not served from it.
 */
export interface StatusPagesClient {
  /** Origin the public page is served from, e.g. `https://app.infrawrench.com`. */
  appOrigin: string;
  listStatusPages(): Promise<StatusPage[]>;
  createStatusPage(body: StatusPageCreate): Promise<StatusPage>;
  updateStatusPage(pageId: string, patch: StatusPagePatch): Promise<StatusPage>;
  deleteStatusPage(pageId: string): Promise<void>;
  /** Issue a fresh slug, revoking the current public URL. */
  rotateSlug(pageId: string): Promise<StatusPage>;
  /** Attach a vanity subdomain (paid plan). */
  attachCustomHostname(pageId: string, body: StatusPageCustomHostnameAttach): Promise<StatusPage>;
  /** Re-check Cloudflare hostname + certificate status. */
  refreshCustomHostname(pageId: string): Promise<StatusPage>;
  /** Detach the vanity subdomain. */
  detachCustomHostname(pageId: string): Promise<StatusPage>;
  /** Probes available to publish — id + name, from the org's probe list. */
  listProbes(): Promise<{ id: string; name: string }[]>;
}
