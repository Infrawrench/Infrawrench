import { useState } from "react";
import { View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  COST_DIMENSION_LABELS,
  COST_DIMENSIONS,
  COST_FILTER_OPS,
  COST_FILTER_OP_LABELS,
  costFilterMatches,
  isKeyedCostDimension,
  isPatternCostFilterOp,
  isValuelessCostFilterOp,
  type CostDimensionId,
  type CostDimensionOption,
  type CostFilter,
  type CostFilterOp,
} from "@infrawrench/client-core";
import { BareInput, Chip, ChipMultiSelect, ChipRow, Field, FormHint } from "@/components/form";
import { Button, Separator } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { tagKeySuggestions } from "./tag-key-options";

/**
 * The filter rules a cost graph or a budget scopes itself with: mobile's
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

/** The operators a row may use: IS SET / IS NOT SET only for tags. */
function opsFor(dimension: CostDimensionId): readonly CostFilterOp[] {
  return isKeyedCostDimension(dimension)
    ? COST_FILTER_OPS
    : COST_FILTER_OPS.filter((op) => !isValuelessCostFilterOp(op));
}

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
 * Values for one dimension, or tag values under one tag key (provider or
 * virtual). `dimension` also accepts "tag-keys" and "virtual-tag-keys" to list
 * the keys themselves, as the API does.
 */
export function useDimensionValues(dimension: string, tagKey?: string | undefined, enabled = true) {
  const { api, orgId } = useOrgApi();
  // A keyed filter (tag, virtual tag) has nothing to list until its key is set.
  const ready =
    enabled && dimension !== "" && (!isKeyedCostDimension(dimension) || Boolean(tagKey));
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
                    // IS SET / IS NOT SET only exist for tags.
                    op: opsFor(o.value as CostDimensionId).includes(filter.op) ? filter.op : "in",
                    // A dimension change invalidates the chosen values and
                    // the key: a provider tag key means nothing to a virtual
                    // tag, and the other dimensions carry none.
                    values: [],
                    tagKey: undefined,
                  })
                }
              />
            ))}
          </ChipRow>
          {filter.dimension === "tag" ? (
            <>
              <BareInput
                accessibilityLabel="Tag key"
                placeholder="tag key"
                value={filter.tagKey ?? ""}
                onChangeText={(tagKey) => update(i, { tagKey })}
              />
              <TagKeySuggestions
                typed={filter.tagKey ?? ""}
                onPick={(tagKey) => update(i, { tagKey, values: [] })}
              />
            </>
          ) : null}
          {filter.dimension === "virtual_tag" ? (
            <VirtualTagKeyChips
              value={filter.tagKey}
              onChange={(tagKey) => update(i, { tagKey, values: [] })}
            />
          ) : null}
          <ChipRow>
            {opsFor(filter.dimension).map((op) => (
              <Chip
                key={op}
                label={COST_FILTER_OP_LABELS[op]}
                selected={filter.op === op}
                onPress={() => update(i, isValuelessCostFilterOp(op) ? { op, values: [] } : { op })}
              />
            ))}
          </ChipRow>
          {isValuelessCostFilterOp(filter.op) ? null : isPatternCostFilterOp(filter.op) ? (
            <TextFilterValues filter={filter} onChange={(values) => update(i, { values })} />
          ) : (
            <FilterValues filter={filter} onChange={(values) => update(i, { values })} />
          )}
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

/**
 * The org's tag keys as chips under the free-text key field, preferred first
 * (starred) and hidden ones left out by the server. The field stays free text:
 * a hidden key is still a valid filter.
 */
function TagKeySuggestions({ typed, onPick }: { typed: string; onPick: (key: string) => void }) {
  const keys = useDimensionValues("tag-keys");
  const chips = tagKeySuggestions(keys.data ?? [], typed);
  if (chips.length === 0) return null;
  return (
    <ChipRow>
      {chips.map((o) => (
        <Chip key={o.value} label={o.label} selected={false} onPress={() => onPick(o.value)} />
      ))}
    </ChipRow>
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
  if (filter.dimension === "virtual_tag" && !filter.tagKey) {
    return <FormHint>Choose a virtual tag to list its values.</FormHint>;
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

/**
 * Typed values for the text operators (is like, contains, starts with): the
 * point is matching spellings the value list does not contain, so they are
 * typed rather than picked. Tap a chip to remove it. The hint counts which
 * known values match, with the same matcher the server's SQL mirrors.
 */
function TextFilterValues({
  filter,
  onChange,
}: {
  filter: CostFilter;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const known = useDimensionValues(filter.dimension, filter.tagKey);
  const add = () => {
    const value = draft.trim();
    setDraft("");
    if (value && !filter.values.includes(value)) onChange([...filter.values, value]);
  };
  const matched =
    filter.values.length > 0
      ? (known.data ?? []).filter((o) => costFilterMatches(filter, o.value)).length
      : 0;
  return (
    <>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <BareInput
          accessibilityLabel="Filter text"
          placeholder="text to match"
          value={draft}
          onChangeText={setDraft}
        />
        <Button label="Add" variant="secondary" onPress={add} />
      </View>
      {filter.values.length > 0 ? (
        <ChipMultiSelect
          options={filter.values.map((v) => ({ value: v, label: `${v}  ✕` }))}
          value={filter.values}
          onChange={onChange}
        />
      ) : null}
      {filter.values.length > 0 && known.data && known.data.length > 0 ? (
        <FormHint>
          {matched === 0
            ? "Matches none of the values seen in cost data yet."
            : `Matches ${matched} known value${matched === 1 ? "" : "s"}.`}
        </FormHint>
      ) : null}
    </>
  );
}

/**
 * The org's virtual tag keys as chips: a virtual tag is something the org
 * defined, so its key is picked from the list rather than typed. A saved key
 * the list no longer returns keeps its chip so it stays visible.
 */
function VirtualTagKeyChips({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (key: string) => void;
}) {
  const keys = useDimensionValues("virtual-tag-keys");
  if (keys.isLoading) return <FormHint>Loading virtual tags…</FormHint>;
  if (keys.isError) return <FormHint>Couldn&apos;t load virtual tags.</FormHint>;
  const options = mergeSelected(keys.data ?? [], value ? [value] : []);
  if (options.length === 0) {
    return <FormHint>No virtual tags yet. Define one in Settings on web or desktop.</FormHint>;
  }
  return (
    <ChipRow>
      {options.map((o) => (
        <Chip
          key={o.value}
          label={o.label}
          selected={o.value === value}
          onPress={() => onChange(o.value)}
        />
      ))}
    </ChipRow>
  );
}
