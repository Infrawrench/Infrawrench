import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CloudApiError,
  COST_ANOMALY_WINDOW,
  clearCostAnomalyFeedback,
  listCostAnomalies,
  submitCostAnomalyFeedback,
  type CostAnomaly,
  type CostAnomalyFeedbackInput,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** How far back the mobile anomalies section looks: the same 30 days web shows. */
export const ANOMALY_WINDOW_DAYS = COST_ANOMALY_WINDOW.defaultDays;

/**
 * Recent spend anomalies for the org (`GET /costs/anomalies`).
 *
 * Detection runs server-side after each cost collection pass, so this is a
 * plain read: there is nothing for a phone to trigger, and nothing to poll for;
 * a pull-to-refresh on the Costs tab is the only reason it refetches.
 */
export function useCostAnomalies(days = ANOMALY_WINDOW_DAYS) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-anomalies", orgId, days],
    queryFn: () => listCostAnomalies(api, orgId, days),
  });
}

/**
 * Give a finding a verdict, or withdraw one (`POST` / `DELETE
 * /costs/anomalies/:id/feedback`, `costs:write`).
 *
 * The response carries the updated anomaly, so the row is patched in place in
 * every cached window rather than refetching the whole list; the server is the
 * one that knows who gave the verdict and whether a suppression came of it.
 */
export function useCostAnomalyFeedback() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();

  const patch = (anomaly: CostAnomaly | null | undefined) => {
    if (!anomaly) return;
    queryClient.setQueriesData<CostAnomaly[]>({ queryKey: ["cost-anomalies", orgId] }, (rows) =>
      rows?.map((row) => (row.id === anomaly.id ? anomaly : row)),
    );
  };

  const submit = useMutation({
    mutationFn: (input: { anomalyId: string; feedback: CostAnomalyFeedbackInput }) =>
      submitCostAnomalyFeedback(api, orgId, input.anomalyId, input.feedback),
    onSuccess: (result) => patch(result?.anomaly),
  });

  const clear = useMutation({
    mutationFn: (anomalyId: string) => clearCostAnomalyFeedback(api, orgId, anomalyId),
    onSuccess: patch,
  });

  return { submit, clear };
}

/**
 * What to show when a feedback write fails. A 403 is a role question, not a
 * fault, so it says what is missing instead of echoing the raw response.
 */
export function costAnomalyFeedbackErrorMessage(e: unknown): string {
  if (e instanceof CloudApiError) {
    if (e.status === 403) {
      return "Your role can't give anomaly feedback. Ask an organization admin for cost write access.";
    }
    try {
      const parsed = JSON.parse(e.body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      /* not JSON: fall through to the raw message */
    }
  }
  return e instanceof Error ? e.message : "Couldn't save the feedback";
}
