/**
 * Incident mode — cloud-mode only. One wrapper per allowlisted IPC channel,
 * matching `cloud-probes.ts`.
 *
 * The declared kind of incident, not a provider status incident.
 */
import type {
  Incident,
  IncidentDeclare,
  IncidentDetailResponse,
  IncidentListResponse,
  IncidentNote,
  IncidentPatch,
  IncidentStatus,
  IncidentTimelineResponse,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";

export async function listCloudIncidents(
  orgId: string,
  status?: IncidentStatus | "all",
): Promise<IncidentListResponse> {
  return invoke("cloud_incidents_list", { orgId, ...(status ? { status } : {}) });
}

export async function getCloudIncident(
  orgId: string,
  incidentId: string,
): Promise<IncidentDetailResponse> {
  return invoke("cloud_incidents_get", { orgId, incidentId });
}

export async function getCloudIncidentTimeline(
  orgId: string,
  incidentId: string,
): Promise<IncidentTimelineResponse> {
  return invoke("cloud_incidents_timeline", { orgId, incidentId });
}

export async function getCloudIncidentPostmortem(
  orgId: string,
  incidentId: string,
): Promise<{ markdown: string; filename: string }> {
  return invoke("cloud_incidents_postmortem", { orgId, incidentId });
}

export async function declareCloudIncident(
  orgId: string,
  input: IncidentDeclare,
): Promise<Incident> {
  return invoke("cloud_incidents_declare", { orgId, input });
}

export async function updateCloudIncident(
  orgId: string,
  incidentId: string,
  patch: IncidentPatch,
): Promise<Incident> {
  return invoke("cloud_incidents_update", { orgId, incidentId, patch });
}

export async function retryCloudIncidentArtifacts(
  orgId: string,
  incidentId: string,
): Promise<Incident> {
  return invoke("cloud_incidents_retry_artifacts", { orgId, incidentId });
}

export async function addCloudIncidentNote(
  orgId: string,
  incidentId: string,
  body: { body: string; occurredAt?: string },
): Promise<IncidentNote> {
  return invoke("cloud_incidents_add_note", { orgId, incidentId, body });
}

export async function deleteCloudIncidentNote(
  orgId: string,
  incidentId: string,
  noteId: string,
): Promise<void> {
  await invoke("cloud_incidents_delete_note", { orgId, incidentId, noteId });
}

export async function deleteCloudIncident(orgId: string, incidentId: string): Promise<void> {
  await invoke("cloud_incidents_delete", { orgId, incidentId });
}
