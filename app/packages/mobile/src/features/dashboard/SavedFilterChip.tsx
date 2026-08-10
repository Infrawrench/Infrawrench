import { useQuery } from "@tanstack/react-query";
import { getSavedCostFilter } from "@infrawrench/client-core";
import { Field, FormHint } from "@/components/form";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The saved cost filter a graph or budget references, rendered read-only.
 *
 * Read-only is a deliberate omission, not a gap: picking, creating and editing
 * saved filters stays on web/desktop, where the referent list and the delete
 * refusal (409 naming referents) can be shown properly. What mobile must not
 * do is *hide* the reference — an editor that silently omitted "prod only"
 * would let a save look narrower or wider than it is — so the chip names the
 * filter and shows the query text it currently resolves to.
 *
 * A reference that fails to resolve is shown as broken rather than skipped,
 * for the same reason the server errors instead of running unfiltered.
 */
export function SavedFilterChip({ savedFilterId }: { savedFilterId: string | undefined }) {
  const { api, orgId } = useOrgApi();
  const query = useQuery({
    queryKey: ["saved-cost-filter", orgId, savedFilterId ?? null],
    enabled: Boolean(savedFilterId),
    queryFn: () => getSavedCostFilter(api, orgId, savedFilterId!),
  });

  if (!savedFilterId) return null;

  return (
    <Field
      label="Saved filter"
      hint="Applied by reference — manage saved filters on web or desktop."
    >
      {query.isLoading ? (
        <FormHint>Loading…</FormHint>
      ) : query.data ? (
        <FormHint>
          {query.data.name}
          {query.data.query ? ` — ${query.data.query}` : ""}
        </FormHint>
      ) : (
        <FormHint>
          This saved filter no longer resolves — queries will fail until it is restored or the
          reference is removed on web or desktop.
        </FormHint>
      )}
    </Field>
  );
}
