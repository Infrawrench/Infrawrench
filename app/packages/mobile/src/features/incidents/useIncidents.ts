import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addIncidentNote,
  declareIncident,
  fetchIncident,
  fetchIncidentTimeline,
  fetchIncidents,
  updateIncident,
  type IncidentDeclare,
  type IncidentStatus,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Incident mode on the phone — the declared kind of incident, not a provider
 * status incident (those are `useProviderIncidents`).
 *
 * Every call is a plain Bearer read/write against the same routes web and
 * desktop use; the fetch helpers live in client-core so there is no mobile copy
 * of the wire contract to drift.
 */
export function useIncidents(status: IncidentStatus | "all" = "all") {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["incidents", orgId, status],
    queryFn: () => fetchIncidents(api, orgId, { status }),
  });
}

export function useIncident(incidentId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["incident", orgId, incidentId],
    queryFn: () => fetchIncident(api, orgId, incidentId),
  });
}

/**
 * The joined timeline. Kept as its own query rather than folded into
 * `useIncident` so a slow union (it reads nine feeds) never holds up the
 * header, which is what somebody woken at 03:14 reads first.
 */
export function useIncidentTimeline(incidentId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["incident-timeline", orgId, incidentId],
    queryFn: () => fetchIncidentTimeline(api, orgId, incidentId),
  });
}

/** Declare from the phone. The artefacts are opt-in exactly as on web. */
export function useDeclareIncident() {
  const { api, orgId } = useOrgApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IncidentDeclare) => declareIncident(api, orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["incidents", orgId] });
    },
  });
}

export function useAddIncidentNote(incidentId: string) {
  const { api, orgId } = useOrgApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => addIncidentNote(api, orgId, incidentId, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["incident", orgId, incidentId] });
      void qc.invalidateQueries({ queryKey: ["incident-timeline", orgId, incidentId] });
    },
  });
}

export function useTransitionIncident(incidentId: string) {
  const { api, orgId } = useOrgApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: IncidentStatus) => updateIncident(api, orgId, incidentId, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["incident", orgId, incidentId] });
      void qc.invalidateQueries({ queryKey: ["incident-timeline", orgId, incidentId] });
      void qc.invalidateQueries({ queryKey: ["incidents", orgId] });
    },
  });
}
