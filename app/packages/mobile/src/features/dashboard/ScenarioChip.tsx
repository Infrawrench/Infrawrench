import { useQuery } from "@tanstack/react-query";
import { getCostScenarioModel } from "@infrawrench/client-core";
import { Field, FormHint } from "@/components/form";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The scenario model a budget's forecast thresholds are measured against,
 * rendered read-only.
 *
 * Read-only is a deliberate omission, exactly as it is for the saved-filter
 * chip: authoring a model is a table of dated, scoped, currency-bearing rows,
 * and picking one for a budget should happen where the referent list and the
 * delete refusal can be shown properly.
 *
 * What mobile must not do is *hide* the reference. The opt-in changes which
 * forecast thresholds fire, so an editor that silently omitted it would let a
 * save quietly move a budget back to the bare trend — and nobody would learn
 * that until a page did not arrive.
 */
export function ScenarioChip({ scenarioModelId }: { scenarioModelId: string | undefined }) {
  const { api, orgId } = useOrgApi();
  const query = useQuery({
    queryKey: ["cost-scenario-model", orgId, scenarioModelId ?? null],
    enabled: Boolean(scenarioModelId),
    queryFn: () => getCostScenarioModel(api, orgId, scenarioModelId!),
  });

  if (!scenarioModelId) return null;

  return (
    <Field
      label="Scenario (forecast thresholds only)"
      hint="Actual-spend thresholds are unaffected. Manage scenario models on web or desktop."
    >
      {query.isLoading ? (
        <FormHint>Loading…</FormHint>
      ) : query.data ? (
        <FormHint>
          {query.data.name} — {query.data.adjustments.length} adjustment
          {query.data.adjustments.length === 1 ? "" : "s"} in {query.data.currency}
        </FormHint>
      ) : (
        <FormHint>
          This scenario model could not be loaded — it may have been deleted. The budget&rsquo;s
          forecast thresholds will error rather than quietly fall back to the trend.
        </FormHint>
      )}
    </Field>
  );
}
