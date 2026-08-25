import type { StatusPagesClient } from "@infrawrench/ui";
import type {
  ProbeListResponse,
  StatusPage,
  StatusPageCreate,
  StatusPageListResponse,
  StatusPagePatch,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * Web implementation of the shared status-pages client, per org.
 *
 * `appOrigin` is the browser's own origin: the public page is served by this
 * same app, so the link the editor shows is the link a visitor will use. On
 * desktop the same client is built against the configured cloud origin
 * instead, which is why the field is on the client rather than derived inside
 * the shared component.
 */
export function createWebStatusPagesClient(orgId: string): StatusPagesClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/status-pages`;
  return {
    appOrigin: typeof window === "undefined" ? "" : window.location.origin,
    listStatusPages: async () => (await apiGet<StatusPageListResponse>(base)).pages,
    createStatusPage: (body: StatusPageCreate) => apiPost<StatusPage>(base, body),
    updateStatusPage: (pageId: string, patch: StatusPagePatch) =>
      apiPut<StatusPage>(`${base}/${encodeURIComponent(pageId)}`, patch),
    deleteStatusPage: async (pageId: string) => {
      await apiDelete(`${base}/${encodeURIComponent(pageId)}`);
    },
    rotateSlug: (pageId: string) =>
      apiPost<StatusPage>(`${base}/${encodeURIComponent(pageId)}/rotate-slug`, {}),
    listProbes: async () => {
      const res = await apiGet<ProbeListResponse>(`/api/org/${encodeURIComponent(orgId)}/probes`);
      return res.probes.map((p) => ({ id: p.id, name: p.name }));
    },
  };
}
