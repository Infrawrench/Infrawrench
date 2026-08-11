import type { IncidentsClient } from "@infrawrench/ui/incidents";
import type {
  Incident,
  IncidentDeclare,
  IncidentDetailResponse,
  IncidentListResponse,
  IncidentNote,
  IncidentPatch,
  IncidentStatus,
  IncidentTimelineResponse,
  StatusPage,
  StatusPageListResponse,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPatch, apiPost } from "./api";

/**
 * Web implementation of the shared incidents client, per org.
 *
 * `canWrite` gates the mutating half rather than the panel deciding for itself:
 * a member holds `incidents:write` and an API-key session might not, and the
 * panel's read-only mode is the same capability convention `ProbesClient` uses.
 */
export function createWebIncidentsClient(orgId: string, canWrite = true): IncidentsClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/incidents`;
  const read: IncidentsClient = {
    listIncidents: async (status) => {
      const query = status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
      return (await apiGet<IncidentListResponse>(`${base}${query}`)).incidents;
    },
    getIncident: (incidentId: string) =>
      apiGet<IncidentDetailResponse>(`${base}/${encodeURIComponent(incidentId)}`),
    getTimeline: (incidentId: string) =>
      apiGet<IncidentTimelineResponse>(`${base}/${encodeURIComponent(incidentId)}/timeline`),
    getPostmortem: (incidentId: string) =>
      apiGet<{ markdown: string; filename: string }>(
        `${base}/${encodeURIComponent(incidentId)}/postmortem`,
      ),
    listStatusPages: async (): Promise<StatusPage[]> =>
      (await apiGet<StatusPageListResponse>(`/api/org/${encodeURIComponent(orgId)}/status-pages`))
        .pages,
  };
  if (!canWrite) return read;
  return {
    ...read,
    declareIncident: (input: IncidentDeclare) => apiPost<Incident>(base, input),
    updateIncident: (incidentId: string, patch: IncidentPatch) =>
      apiPatch<Incident>(`${base}/${encodeURIComponent(incidentId)}`, patch),
    addNote: (incidentId: string, body: string, occurredAt?: string) =>
      apiPost<IncidentNote>(`${base}/${encodeURIComponent(incidentId)}/notes`, {
        body,
        ...(occurredAt ? { occurredAt } : {}),
      }),
    deleteNote: async (incidentId: string, noteId: string) => {
      await apiDelete(
        `${base}/${encodeURIComponent(incidentId)}/notes/${encodeURIComponent(noteId)}`,
      );
    },
    retryArtifacts: (incidentId: string) =>
      apiPost<Incident>(`${base}/${encodeURIComponent(incidentId)}/retry-artifacts`, {}),
    deleteIncident: async (incidentId: string) => {
      await apiDelete(`${base}/${encodeURIComponent(incidentId)}`);
    },
  } satisfies IncidentsClient & { declareIncident: (input: IncidentDeclare) => Promise<Incident> };
}

export type { IncidentStatus };
