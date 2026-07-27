import { View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  COST_DIMENSION_LABELS,
  COST_DIMENSIONS,
  type CostDimensionId,
  type CostDimensionOption,
  type CostFilter,
} from "@infrawrench/client-core";
import { BareInput, Chip, ChipMultiSelect, ChipRow, Field, FormHint } from "@/components/form";
import { Button, Separator } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The filter rules a cost graph or a budget scopes itself with — mobile's
 * counterpart of web's `CostFilterRows`.
 *
 * Web renders a dimension select, an operator select, and a searchable
 * multi-select of values. Here each of those is a chip row: the value lists
 * come from the same `GET /costs/dimensions`, so a filter authored on a phone
 * is byte-identical to one authored on the web.
 */

const DIMENSION_OPTIONS = COST_DIMENSIONS.map((d) => ({
  value: d,
  label: COST_DIMENSION_LABELS[d],
}));

/**
 * Options plus any selected value the load didn't return, so a filter saved
 * against a service that has since stopped appearing in cost data still shows
 * its chip (and can still be deselected) instead of disappearing.
 */
function mergeSelected(options: CostDimensionOption[], values: string[]): CostDimensionOption[] {
  const known = new Set(options.map((o) => o.value));
  const extra = values.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }));
  return extra.length === 0 ? options : [...options, ...extra];
}

/**
 * Values for one dimension, or tag values under one tag key. `dimension` also
 * accepts "tag-keys" to list the keys themselves, as the API does.
 */
export function useDimensionValues(dimension: string, tagKey?: string | undefined, enabled = true) {
  const { api, orgId } = useOrgApi();
  // A tag filter has nothing to list until its key is typed.
  const ready = enabled && dimension !== "" && (dimension !== "tag" || Boolean(tagKey));
  return useQuery({
    queryKey: ["cost-dimensions", orgId, dimension, tagKey ?? null],
    enabled: ready,
    queryFn: async () => {
      const query = new URLSearchParams({ dimension });
      if (tagKey) query.set("tagKey", tagKey);
      const res = await api.org<{ values: CostDimensionOption[] }>(
        orgId,
        `/costs/dimensions?${query.toString()}`,
      );
      return res?.values ?? [];
    },
  });
}

export function CostFilterEditor({
  filters,
  onChange,
  label = "Filters",
  hint,
}: {
  filters: CostFilter[];
  onChange: (filters: CostFilter[]) => void;
  label?: string;
  hint?: string | undefined;
}) {
  const update = (index: number, patch: Partial<CostFilter>) => {
    onChange(filters.map((f, i) => (i === index ? ({ ...f, ...patch } as CostFilter) : f)));
  };

  return (
    <Field label={label} hint={hint}>
      {filters.map((filter, i) => (
        <View key={i} style={{ gap: 6, marginBottom: 8 }}>
          {i > 0 ? <Separator /> : null}
          <ChipRow>
            {DIMENSION_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                selected={o.value === filter.dimension}
                onPress={() =>
                  update(i, {
                    dimension: o.value as CostDimensionId,
                    // A dimension change invalidates the chosen values, and
                    // only a tag filter carries a key.
                    values: [],
                    ...(o.value === "tag" ? {} : { tagKey: undefined }),
                  })
                }
              />
            ))}
          </ChipRow>
          {filter.dimension === "tag" ? (
            <BareInput
              accessibilityLabel="Tag key"
              placeholder="tag key"
              value={filter.tagKey ?? ""}
              onChangeText={(tagKey) => update(i, { tagKey })}
            />
          ) : null}
          <ChipRow>
            <Chip
              label="is"
              selected={filter.op === "in"}
              onPress={() => update(i, { op: "in" })}
            />
            <Chip
              label="is not"
              selected={filter.op === "not_in"}
              onPress={() => update(i, { op: "not_in" })}
            />
          </ChipRow>
          <FilterValues filter={filter} onChange={(values) => update(i, { values })} />
          <Button
            label="Remove filter"
            variant="secondary"
            onPress={() => onChange(filters.filter((_, j) => j !== i))}
          />
        </View>
      ))}
      <Button
        label="Add filter"
        variant="secondary"
        onPress={() => onChange([...filters, { dimension: "provider", op: "in", values: [] }])}
      />
    </Field>
  );
}

function FilterValues({
  filter,
  onChange,
}: {
  filter: CostFilter;
  onChange: (values: string[]) => void;
}) {
  const values = useDimensionValues(filter.dimension, filter.tagKey);

  if (filter.dimension === "tag" && !filter.tagKey) {
    return <FormHint>Enter a tag key to list its values.</FormHint>;
  }
  if (values.isLoading) return <FormHint>Loading values…</FormHint>;
  if (values.isError) return <FormHint>Couldn&apos;t load values.</FormHint>;

  return (
    <ChipMultiSelect
      options={mergeSelected(values.data ?? [], filter.values)}
      value={filter.values}
      onChange={onChange}
      emptyMessage="No values in cost data yet"
    />
  );
}
