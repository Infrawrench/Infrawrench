import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type {
  CostEstimate,
  CreateResourceConfig,
  CreateFieldConfig,
} from "@infrawrench/plugin-base";
import { formatMonthlyEstimate } from "@infrawrench/client-core";
import { evaluateShowWhen, buildDefaultFields, formatErrorMessage } from "../utils.js";

/** Callback signatures that each platform provides */
export interface CreateResourceCallbacks {
  /** Load the create config for this resource type */
  loadConfig: () => Promise<CreateResourceConfig>;
  /** Fetch pricing for a set of sizes in a region */
  loadSizePricing?: (request: {
    regionId?: string;
    sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
  }) => Promise<Record<string, number>>;
  /**
   * Get a full cost estimate — total plus line items — for the current field
   * values. Called on a debounce as the user edits, so a host that fetches
   * over the network gets at most one request per pause, not one per
   * keystroke.
   */
  loadCostEstimate?: (fields: Record<string, string>) => Promise<CostEstimate | null>;
  /** Submit the create form — platform handles the result via its own callback */
  create: (fields: Record<string, string>) => Promise<void>;
  /**
   * Execute an in-form field action (e.g. mint an IAM role) — only used when
   * the loaded `CreateResourceConfig` declares `actions` on a field. Returns
   * the new value plus an optional option entry that should be spliced into
   * the field's options list so the value can render in a select.
   */
  executeFieldAction?: (
    fieldKey: string,
    actionId: string,
    fields: Record<string, string>,
    actionFields?: Record<string, string>,
  ) => Promise<{ value: string; option?: { id: string; label: string } }>;
}

export interface CreateResourceFormState {
  config: CreateResourceConfig | null;
  configWithPricing: CreateResourceConfig | null;
  loadingConfig: boolean;
  configError: string | null;
  fields: Record<string, string>;
  setField: (key: string, value: string) => void;
  creating: boolean;
  error: string | null;
  visibleFields: CreateFieldConfig[];
  isValid: boolean;
  estimatedMonthlyPriceLabel: string | null;
  /**
   * The plugin's itemized estimate, when it supplied one. Null when only the
   * size picker's price is available (which still gives a
   * `estimatedMonthlyPriceLabel`) or when nothing could be priced at all.
   */
  costEstimate: CostEstimate | null;
  handleCreate: () => Promise<void>;
  /** Whether an action on this field is currently running (keyed by field key). */
  fieldActionRunning: Record<string, boolean>;
  /** Most-recent error from a failed action, keyed by field key. */
  fieldActionError: Record<string, string | null>;
  /**
   * Per-field counter incremented on each successful field action. Components
   * that fetch field options (e.g. the resource picker) can include this as a
   * dependency to refetch after an inline-create action mints a new resource.
   */
  fieldRefreshKey: Record<string, number>;
  /**
   * Run a field-level action and apply its result to the form state.
   * `actionFields` carries values from the action's inline form (when the
   * action declares `formFields`); omit for plain one-click actions.
   */
  runFieldAction: (
    fieldKey: string,
    actionId: string,
    actionFields?: Record<string, string>,
  ) => Promise<void>;
}

export function useCreateResourceForm(
  callbacks: CreateResourceCallbacks,
  /** Used as dependency keys to reset the form when they change */
  deps: unknown[],
): CreateResourceFormState {
  const [config, setConfig] = useState<CreateResourceConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizePricingByRegion, setSizePricingByRegion] = useState<
    Record<string, Record<string, number>>
  >({});
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const pricingAttemptedRef = useRef<Map<string, Set<string>> | null>(null);
  if (pricingAttemptedRef.current === null) pricingAttemptedRef.current = new Map();
  const pricingInFlightRef = useRef<Set<string> | null>(null);
  if (pricingInFlightRef.current === null) pricingInFlightRef.current = new Set();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const setField = useCallback((key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const regionField = useMemo(
    () => config?.fields.find((f) => f.kind === "region-picker" && f.regions?.length),
    [config],
  );
  const sizeField = useMemo(
    () => config?.fields.find((f) => f.kind === "size-picker" && f.sizes?.length),
    [config],
  );

  const selectedRegionId = useMemo(() => {
    if (!regionField) return undefined;
    return fields[regionField.key] ?? regionField.defaultValue ?? regionField.regions?.[0]?.id;
  }, [fields, regionField]);

  const selectedSizeId = useMemo(() => {
    if (!sizeField) return undefined;
    return fields[sizeField.key] ?? sizeField.defaultValue ?? sizeField.sizes?.[0]?.id;
  }, [fields, sizeField]);

  async function loadPricingForRegion(
    regionId: string | undefined,
    cfgOverride?: CreateResourceConfig,
    sizeIdsOverride?: string[],
  ): Promise<void> {
    const loadSizePricing = callbacksRef.current.loadSizePricing;
    if (!loadSizePricing) return;
    const cfg = cfgOverride ?? config;
    if (!cfg) return;
    const cfgSizeField = cfg.fields.find((f) => f.kind === "size-picker" && f.sizes?.length);
    if (!cfgSizeField?.sizes?.length) return;

    const requestedSizes = sizeIdsOverride?.length
      ? cfgSizeField.sizes.filter((s) => sizeIdsOverride.includes(s.id))
      : cfgSizeField.sizes;
    if (!requestedSizes.length) return;

    const regionKey = regionId ?? "__default__";
    const attemptedForRegion = pricingAttemptedRef.current!.get(regionKey) ?? new Set<string>();
    const pendingSizes = requestedSizes.filter((s) => !attemptedForRegion.has(s.id));
    if (!pendingSizes.length) return;
    const requestKey = `${regionKey}|${pendingSizes
      .map((s) => s.id)
      .sort()
      .join(",")}`;
    if (pricingInFlightRef.current!.has(requestKey)) return;

    pricingInFlightRef.current!.add(requestKey);
    try {
      const pricing = await loadSizePricing({
        ...(regionId ? { regionId } : {}),
        sizes: pendingSizes.map((size) => ({
          id: size.id,
          vcpus: size.vcpus,
          memoryMb: size.memoryMb,
        })),
      });
      for (const s of pendingSizes) attemptedForRegion.add(s.id);
      pricingAttemptedRef.current!.set(regionKey, attemptedForRegion);
      if (!pricing || Object.keys(pricing).length === 0) return;
      setSizePricingByRegion((prev) => ({
        ...prev,
        [regionKey]: { ...(prev[regionKey] ?? {}), ...pricing },
      }));
    } catch {
      // Allow retries on failures
    } finally {
      pricingInFlightRef.current!.delete(requestKey);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoadingConfig(true);
        setConfigError(null);
        setSizePricingByRegion({});
        setCostEstimate(null);
        pricingAttemptedRef.current!.clear();
        pricingInFlightRef.current!.clear();

        const cfg = await callbacksRef.current.loadConfig();
        if (cancelled) return;
        setConfig(cfg);
        const init = buildDefaultFields(cfg.fields);
        setFields(init);

        // Progressive pricing loading
        const cfgRegionField = cfg.fields.find(
          (f) => f.kind === "region-picker" && f.regions?.length,
        );
        const defaultRegionId = cfgRegionField
          ? (init[cfgRegionField.key] ??
            cfgRegionField.defaultValue ??
            cfgRegionField.regions?.[0]?.id)
          : undefined;
        const cfgSizeField = cfg.fields.find((f) => f.kind === "size-picker" && f.sizes?.length);
        const defaultSizeId = cfgSizeField
          ? (init[cfgSizeField.key] ?? cfgSizeField.defaultValue ?? cfgSizeField.sizes?.[0]?.id)
          : undefined;

        if (cfgRegionField?.regions?.length) {
          const remainingRegionIds = cfgRegionField.regions.flatMap((r) =>
            r.id !== defaultRegionId ? [r.id] : [],
          );
          void (async () => {
            await loadPricingForRegion(
              defaultRegionId,
              cfg,
              defaultSizeId ? [defaultSizeId] : undefined,
            );
            if (cancelled) return;
            for (const regionId of remainingRegionIds) {
              if (cancelled) return;
              await loadPricingForRegion(
                regionId,
                cfg,
                defaultSizeId ? [defaultSizeId] : undefined,
              );
            }
            if (cancelled) return;
            await loadPricingForRegion(defaultRegionId, cfg);
            for (const regionId of remainingRegionIds) {
              if (cancelled) return;
              await loadPricingForRegion(regionId, cfg);
            }
          })();
        } else {
          void (async () => {
            await loadPricingForRegion(
              defaultRegionId,
              cfg,
              defaultSizeId ? [defaultSizeId] : undefined,
            );
            await loadPricingForRegion(defaultRegionId, cfg);
          })();
        }
      } catch (e) {
        if (!cancelled) setConfigError(formatErrorMessage(e));
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!config) return;
    void (async () => {
      await loadPricingForRegion(
        selectedRegionId,
        undefined,
        selectedSizeId ? [selectedSizeId] : undefined,
      );
      await loadPricingForRegion(selectedRegionId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, selectedRegionId, selectedSizeId]);

  const configWithPricing = useMemo(() => {
    if (!config) return null;
    const selectedRegionKey = selectedRegionId ?? "__default__";
    const regionPricing = sizePricingByRegion[selectedRegionKey];
    if (!regionPricing) return config;
    return {
      ...config,
      fields: config.fields.map((field) => {
        if (field.kind !== "size-picker" || !field.sizes) return field;
        return {
          ...field,
          sizes: field.sizes.map((size) => {
            const regionPrice = regionPricing[size.id];
            return regionPrice != null ? { ...size, priceMonthly: regionPrice } : size;
          }),
        };
      }),
    };
  }, [config, selectedRegionId, sizePricingByRegion]);

  useEffect(() => {
    if (!configWithPricing) return;
    const loadCostEstimate = callbacksRef.current.loadCostEstimate;
    if (!loadCostEstimate) {
      setCostEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const visibleFields: Record<string, string> = {};
      for (const f of configWithPricing.fields) {
        if (!evaluateShowWhen(f, fields)) continue;
        if (fields[f.key] !== undefined) visibleFields[f.key] = fields[f.key]!;
      }
      void loadCostEstimate(visibleFields)
        .then((value) => {
          if (!cancelled) setCostEstimate(value ?? null);
        })
        .catch(() => {
          if (!cancelled) setCostEstimate(null);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [configWithPricing, fields]);

  const estimatedMonthlyPrice = useMemo(() => {
    // The plugin's own estimate wins: it accounts for the components the size
    // picker's per-size price cannot see (boot disks, node counts, storage).
    if (costEstimate != null) return costEstimate.monthlyAmount;
    if (!configWithPricing) return null;
    const vf = configWithPricing.fields.filter((f) => evaluateShowWhen(f, fields));
    const sf = vf.find((f) => f.kind === "size-picker" && f.sizes?.length);
    if (!sf?.sizes) return null;
    const sid = fields[sf.key];
    if (!sid) return null;
    const selectedSize = sf.sizes.find((size) => size.id === sid);
    if (selectedSize?.priceMonthly == null) return null;
    return selectedSize.priceMonthly;
  }, [configWithPricing, fields, costEstimate]);

  const estimatedMonthlyPriceLabel = useMemo(() => {
    if (estimatedMonthlyPrice == null) return null;
    return formatMonthlyEstimate(estimatedMonthlyPrice, costEstimate?.currency ?? "USD");
  }, [estimatedMonthlyPrice, costEstimate]);

  const visibleFields = useMemo(() => {
    if (!configWithPricing) return [];
    return configWithPricing.fields.filter((f) => evaluateShowWhen(f, fields));
  }, [configWithPricing, fields]);

  const isValid = useMemo(() => {
    if (!configWithPricing) return false;
    for (const f of visibleFields) {
      if (!f.required) continue;
      const value = fields[f.key];
      if (typeof value !== "string" || value.trim().length === 0) return false;
    }
    return true;
  }, [configWithPricing, visibleFields, fields]);

  const [fieldActionRunning, setFieldActionRunning] = useState<Record<string, boolean>>({});
  const [fieldActionError, setFieldActionError] = useState<Record<string, string | null>>({});
  // Per-field counter bumped on each successful action. The resource-picker
  // reads this to know it should re-fetch after a "+ Create new …" inline
  // action mints a new resource, so the newly-minted resource shows up as
  // selected instead of vanishing into the not-yet-listed pool.
  const [fieldRefreshKey, setFieldRefreshKey] = useState<Record<string, number>>({});

  const runFieldAction = useCallback(
    async (fieldKey: string, actionId: string, actionFields?: Record<string, string>) => {
      const exec = callbacksRef.current.executeFieldAction;
      if (!exec) return;
      setFieldActionRunning((prev) => ({ ...prev, [fieldKey]: true }));
      setFieldActionError((prev) => ({ ...prev, [fieldKey]: null }));
      try {
        const result = await exec(fieldKey, actionId, fields, actionFields);
        // If the action returned a synthetic option, splice it into the
        // field's options list so the new value can render in the select.
        if (result.option) {
          setConfig((prev) => {
            if (!prev) return prev;
            const nextFields = prev.fields.map((f) => {
              if (f.key !== fieldKey) return f;
              const existing = f.options ?? [];
              if (existing.some((o) => o.id === result.option!.id)) return f;
              return { ...f, options: [result.option!, ...existing] };
            });
            return { ...prev, fields: nextFields };
          });
        }
        setFields((prev) => ({ ...prev, [fieldKey]: result.value }));
        setFieldRefreshKey((prev) => ({ ...prev, [fieldKey]: (prev[fieldKey] ?? 0) + 1 }));
      } catch (e) {
        setFieldActionError((prev) => ({ ...prev, [fieldKey]: formatErrorMessage(e) }));
      } finally {
        setFieldActionRunning((prev) => ({ ...prev, [fieldKey]: false }));
      }
    },
    [fields],
  );

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const submitFields: Record<string, string> = {};
      const cfg = configWithPricing ?? config;
      for (const f of cfg?.fields ?? []) {
        // Transient fields (e.g. a mode toggle) are UI-only controls — never
        // submit them to the plugin.
        if (f.transient) continue;
        if (!evaluateShowWhen(f, fields)) continue;
        if (fields[f.key] !== undefined) submitFields[f.key] = fields[f.key]!;
      }
      await callbacksRef.current.create(submitFields);
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configWithPricing, config, fields]);

  return {
    config,
    configWithPricing,
    loadingConfig,
    configError,
    fields,
    setField,
    creating,
    error,
    visibleFields,
    isValid,
    estimatedMonthlyPriceLabel,
    costEstimate,
    handleCreate,
    fieldActionRunning,
    fieldActionError,
    runFieldAction,
    fieldRefreshKey,
  };
}
