/**
 * Incident mode: cloud-mode only. Typed calls to the contract's `incidents`
 * domain and the paging providers' `pagingIncidents` group over the cloud
 * transport (`./cloud-client.ts`), matching `cloud-probes.ts`.
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
  PagerIncidentRecord,
  PagerIncidentsResponse,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const incidents = () => cloudClient("incidents").incidents;
const pagingIncidents = () => cloudClient("pagingProviders").pagingIncidents;

export async function listCloudIncidents(
  orgId: string,
  status?: IncidentStatus | "all",
): Promise<IncidentListResponse> {
  return runRpc(
    incidents().list({
      params: { orgId },
      query: status && status !== "all" ? { status } : {},
    }),
  );
}

export async function getCloudIncident(
  orgId: string,
  incidentId: string,
): Promise<IncidentDetailResponse> {
  return runRpc(incidents().get({ params: { orgId, incidentId } }));
}

export async function getCloudIncidentTimeline(
  orgId: string,
  incidentId: string,
): Promise<IncidentTimelineResponse> {
  return runRpc(incidents().timeline({ params: { orgId, incidentId } }));
}

export async function getCloudIncidentPostmortem(
  orgId: string,
  incidentId: string,
): Promise<{ markdown: string; filename: string }> {
  return runRpc(incidents().postmortem({ params: { orgId, incidentId } }));
}

export async function declareCloudIncident(
  orgId: string,
  input: IncidentDeclare,
): Promise<Incident> {
  return runRpc(incidents().declare({ params: { orgId }, payload: input }));
}

export async function updateCloudIncident(
  orgId: string,
  incidentId: string,
  patch: IncidentPatch,
): Promise<Incident> {
  return runRpc(incidents().update({ params: { orgId, incidentId }, payload: patch }));
}

export async function retryCloudIncidentArtifacts(
  orgId: string,
  incidentId: string,
): Promise<Incident> {
  return runRpc(incidents().retryArtifacts({ params: { orgId, incidentId } }));
}

export async function addCloudIncidentNote(
  orgId: string,
  incidentId: string,
  body: { body: string; occurredAt?: string },
): Promise<IncidentNote> {
  return runRpc(incidents().addNote({ params: { orgId, incidentId }, payload: body }));
}

export async function deleteCloudIncidentNote(
  orgId: string,
  incidentId: string,
  noteId: string,
): Promise<void> {
  await runRpc(incidents().deleteNote({ params: { orgId, incidentId, noteId } }));
}

export async function deleteCloudIncident(orgId: string, incidentId: string): Promise<void> {
  await runRpc(incidents().delete({ params: { orgId, incidentId } }));
}

/** Incidents mirrored from paging providers (PagerDuty, incident.io). */
export async function listCloudPagerIncidents(
  orgId: string,
  status: "open" | "all",
): Promise<PagerIncidentsResponse> {
  return runRpc(
    pagingIncidents().list({
      params: { orgId },
      query: status === "all" ? { status: "all" } : {},
    }),
  );
}

/**
 * Acknowledge or resolve a provider incident upstream. The action is checked
 * before anything is sent: it picks the endpoint, and a value from outside
 * the type (a stale caller) must not reach the network as some other route.
 */
export async function actOnCloudPagerIncident(
  orgId: string,
  incidentId: string,
  action: "acknowledge" | "resolve",
): Promise<PagerIncidentRecord> {
  const params = { orgId, id: incidentId };
  if (action === "acknowledge") return runRpc(pagingIncidents().acknowledge({ params }));
  if (action === "resolve") return runRpc(pagingIncidents().resolve({ params }));
  throw new Error(`Unknown paging incident action "${String(action)}"`);
}
