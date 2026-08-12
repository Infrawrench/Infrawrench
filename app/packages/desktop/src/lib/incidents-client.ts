import { useUIStore } from "@infrawrench/ui";
import type { IncidentsClient } from "@infrawrench/ui/incidents";
import {
  addCloudIncidentNote,
  declareCloudIncident,
  deleteCloudIncident,
  deleteCloudIncidentNote,
  getCloudIncident,
  getCloudIncidentPostmortem,
  getCloudIncidentTimeline,
  listCloudIncidents,
  retryCloudIncidentArtifacts,
  updateCloudIncident,
} from "./cloud-incidents";
import { listCloudStatusPages } from "./cloud-status-pages";

/**
 * Incidents are cloud-only: the object is org-scoped and declaring composes
 * cloud features (change freezes, alert routing, status pages), none of which a
 * local-mode desktop app has. The active org is resolved at call time rather
 * than closed over, matching `probes-client.ts` — the org can change under a
 * mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Incidents require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopIncidentsClient(): IncidentsClient {
  return {
    listIncidents: async (status) => (await listCloudIncidents(requireOrgId(), status)).incidents,
    getIncident: (incidentId) => getCloudIncident(requireOrgId(), incidentId),
    getTimeline: (incidentId) => getCloudIncidentTimeline(requireOrgId(), incidentId),
    getPostmortem: (incidentId) => getCloudIncidentPostmortem(requireOrgId(), incidentId),
    // Best-effort: an org with no status pages (or a failure reading them) just
    // loses the "tell the public" row of the declare form.
    listStatusPages: async () => (await listCloudStatusPages(requireOrgId())).pages,
    declareIncident: (input) => declareCloudIncident(requireOrgId(), input),
    updateIncident: (incidentId, patch) => updateCloudIncident(requireOrgId(), incidentId, patch),
    addNote: (incidentId, body, occurredAt) =>
      addCloudIncidentNote(requireOrgId(), incidentId, {
        body,
        ...(occurredAt ? { occurredAt } : {}),
      }),
    deleteNote: (incidentId, noteId) => deleteCloudIncidentNote(requireOrgId(), incidentId, noteId),
    retryArtifacts: (incidentId) => retryCloudIncidentArtifacts(requireOrgId(), incidentId),
    deleteIncident: (incidentId) => deleteCloudIncident(requireOrgId(), incidentId),
  };
}
