import { useUIStore } from "@infrawrench/ui";
import type { StatusPagesClient } from "@infrawrench/ui";
import { CLOUD_URL } from "../../env";
import { listCloudProbes } from "./cloud-probes";
import {
  createCloudStatusPage,
  deleteCloudStatusPage,
  listCloudStatusPages,
  rotateCloudStatusPageSlug,
  updateCloudStatusPage,
} from "./cloud-status-pages";

/**
 * Status pages are cloud-only, like the probes they publish. The active org is
 * resolved at call time rather than closed over, matching `probes-client.ts` —
 * the org can change under a mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Status pages require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopStatusPagesClient(): StatusPagesClient {
  return {
    // Desktop is not served from the cloud app, so the public URL it shows has
    // to be the *cloud's* origin — not `window.location`, which is a file: or
    // localhost URL here and would produce a link that goes nowhere.
    appOrigin: CLOUD_URL,
    listStatusPages: async () => (await listCloudStatusPages(requireOrgId())).pages,
    createStatusPage: (body) => createCloudStatusPage(requireOrgId(), body),
    updateStatusPage: (pageId, patch) => updateCloudStatusPage(requireOrgId(), pageId, patch),
    deleteStatusPage: (pageId) => deleteCloudStatusPage(requireOrgId(), pageId),
    rotateSlug: (pageId) => rotateCloudStatusPageSlug(requireOrgId(), pageId),
    listProbes: async () =>
      (await listCloudProbes(requireOrgId())).probes.map((p) => ({ id: p.id, name: p.name })),
  };
}
