import { useState, useEffect, useMemo, useRef } from "react";
import { formatErrorMessage } from "../lib/errors";
import { createPluginClient } from "../lib/plugin-client";
import { Modal, buildDefaultFields, evaluateShowWhen } from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { FieldRenderer } from "./create-resource";
import type { PluginClient, ResourceTypeDefinition, CreateResourceConfig } from "@infrawrench/plugin-base";

interface CreateResourceModalProps {
  accountId: string;
  pluginId: string;
  resourceType: ResourceTypeDefinition;
  clientFactory?: () => PluginClient | Promise<PluginClient>;
  onClose: () => void;
  onCreated: (resource: import("@infrawrench/plugin-base").ResourceInstance) => void;
}

export function CreateResourceModal({
  accountId,
  pluginId,
  resourceType,
  clientFactory,
  onClose,
  onCreated,
}: CreateResourceModalProps) {
  const [config, setConfig] = useState<CreateResourceConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizePricingByRegion, setSizePricingByRegion] = useState<Record<string, Record<string, number>>>({});
  const [costEstimateMonthly, setCostEstimateMonthly] = useState<number | null>(null);
  const clientRef = useRef<PluginClient | null>(null);
  const pricingAttemptedRef = useRef<Map<string, Set<string>>>(new Map());
  const pricingInFlightRequestsRef = useRef<Set<string>>(new Set());

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
    const cfg = cfgOverride ?? config;
    const client = clientRef.current;
    if (!cfg || !client?.getCreateSizePricing) return;
    const cfgSizeField = cfg.fields.find((f) => f.kind === "size-picker" && f.sizes?.length);
    if (!cfgSizeField?.sizes?.length) return;

    const requestedSizes = sizeIdsOverride?.length
      ? cfgSizeField.sizes.filter((s) => sizeIdsOverride.includes(s.id))
      : cfgSizeField.sizes;
    if (!requestedSizes.length) return;

    const regionKey = regionId ?? "__default__";
    const attemptedForRegion = pricingAttemptedRef.current.get(regionKey) ?? new Set<string>();
    const pendingSizes = requestedSizes.filter((s) => !attemptedForRegion.has(s.id));
    if (!pendingSizes.length) return;
    const requestKey = `${regionKey}|${pendingSizes.map((s) => s.id).sort().join(",")}`;
    if (pricingInFlightRequestsRef.current.has(requestKey)) return;

    pricingInFlightRequestsRef.current.add(requestKey);
    try {
      const pricing = await client.getCreateSizePricing(resourceType.id, {
        ...(regionId ? { regionId } : {}),
        sizes: pendingSizes.map((size) => ({
          id: size.id,
          vcpus: size.vcpus,
          memoryMb: size.memoryMb,
        })),
      });
      for (const s of pendingSizes) attemptedForRegion.add(s.id);
      pricingAttemptedRef.current.set(regionKey, attemptedForRegion);
      if (!pricing || Object.keys(pricing).length === 0) return;
      setSizePricingByRegion((prev) => ({
        ...prev,
        [regionKey]: {
          ...(prev[regionKey] ?? {}),
          ...pricing,
        },
      }));
    } catch {
      // Allow retries on failures by not marking attempts.
    } finally {
      pricingInFlightRequestsRef.current.delete(requestKey);
    }
  }

  // Load the create config (API-driven: regions, sizes, etc.)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoadingConfig(true);
        setConfigError(null);
        setSizePricingByRegion({});
        setCostEstimateMonthly(null);
        pricingAttemptedRef.current.clear();
        pricingInFlightRequestsRef.current.clear();
        clientRef.current = null;
        const client = clientFactory
          ? await clientFactory()
          : await createPluginClient(accountId, pluginId);
        clientRef.current = client;
        if (!client.getCreateConfig) throw new Error("Plugin does not support dynamic create config");
        const cfg = await client.getCreateConfig(resourceType.id);
        if (!cancelled) {
          setConfig(cfg);
          const init = buildDefaultFields(cfg.fields);
          setFields(init);

          const cfgRegionField = cfg.fields.find((f) => f.kind === "region-picker" && f.regions?.length);
          const defaultRegionId = cfgRegionField
            ? (init[cfgRegionField.key] ?? cfgRegionField.defaultValue ?? cfgRegionField.regions?.[0]?.id)
            : undefined;
          const cfgSizeField = cfg.fields.find((f) => f.kind === "size-picker" && f.sizes?.length);
          const defaultSizeId = cfgSizeField
            ? (init[cfgSizeField.key] ?? cfgSizeField.defaultValue ?? cfgSizeField.sizes?.[0]?.id)
            : undefined;

          // Progressive pricing with strict priority:
          // 1) selected/default SKU + selected/default region
          // 2) selected/default SKU across other regions
          // 3) remaining SKUs for selected/default region
          // 4) remaining SKUs for other regions
          if (cfgRegionField?.regions?.length) {
            const remainingRegionIds = cfgRegionField.regions
              .map((r) => r.id)
              .filter((id) => id !== defaultRegionId);
            void (async () => {
              await loadPricingForRegion(
                defaultRegionId,
                cfg,
                defaultSizeId ? [defaultSizeId] : undefined,
              );
              if (cancelled) return;
              await new Promise((resolve) => setTimeout(resolve, 300));
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
      clientRef.current = null;
    };
  }, [accountId, clientFactory, pluginId, resourceType.id]);

  useEffect(() => {
    if (!config) return;
    void (async () => {
      await loadPricingForRegion(selectedRegionId, undefined, selectedSizeId ? [selectedSizeId] : undefined);
      await loadPricingForRegion(selectedRegionId);
    })();
  }, [config, selectedRegionId, selectedSizeId]);

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

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
    const client = clientRef.current;
    if (!client?.getCreateCostEstimate) {
      setCostEstimateMonthly(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const visibleFields: Record<string, string> = {};
      for (const f of configWithPricing.fields) {
        if (!evaluateShowWhen(f, fields)) continue;
        if (fields[f.key] !== undefined) visibleFields[f.key] = fields[f.key]!;
      }
      void client.getCreateCostEstimate!(resourceType.id, visibleFields)
        .then((value) => {
          if (!cancelled) setCostEstimateMonthly(value ?? null);
        })
        .catch(() => {
          if (!cancelled) setCostEstimateMonthly(null);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [configWithPricing, fields, resourceType.id]);

  const estimatedMonthlyPrice = useMemo(() => {
    if (costEstimateMonthly != null) return costEstimateMonthly;
    if (!configWithPricing) return null;
    const visibleFields = configWithPricing.fields.filter(
      (f) => evaluateShowWhen(f, fields),
    );
    const sizeField = visibleFields.find((f) => f.kind === "size-picker" && f.sizes?.length);
    if (!sizeField?.sizes) return null;
    const selectedSizeId = fields[sizeField.key];
    if (!selectedSizeId) return null;
    const selectedSize = sizeField.sizes.find((size) => size.id === selectedSizeId);
    if (selectedSize?.priceMonthly == null) return null;
    return selectedSize.priceMonthly;
  }, [configWithPricing, fields, costEstimateMonthly]);

  const estimatedMonthlyPriceLabel = useMemo(() => {
    if (estimatedMonthlyPrice == null) return null;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: estimatedMonthlyPrice % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(estimatedMonthlyPrice);
  }, [estimatedMonthlyPrice]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const client = clientRef.current
        ?? (clientFactory
          ? await clientFactory()
          : await createPluginClient(accountId, pluginId));
      if (!client.createResource) throw new Error("Plugin does not support resource creation");
      // Only submit fields that are currently visible (respect showWhen)
      const cfg = config;
      const visibleFields: Record<string, string> = {};
      for (const f of (cfg?.fields ?? [])) {
        if (!evaluateShowWhen(f, fields)) continue;
        if (fields[f.key] !== undefined) visibleFields[f.key] = fields[f.key]!;
      }
      const created = await client.createResource(resourceType.id, accountId, visibleFields);
      onCreated(created);
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[72vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-100">
            Create {resourceType.displayName}
          </h2>
          <div className="flex items-center gap-3">
            {estimatedMonthlyPriceLabel && (
              <div className="text-right px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <p className="text-[10px] uppercase tracking-wide text-emerald-300/80">Estimated cost</p>
                <p className="text-sm font-semibold text-emerald-200">{estimatedMonthlyPriceLabel}/mo</p>
              </div>
            )}
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 text-xl leading-none">×</button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {loadingConfig ? (
            <div className="flex items-center gap-3 text-sm text-gray-500 py-8 justify-center">
              <span className="animate-spin inline-block w-4 h-4 rounded-full border-2 border-gray-600 border-t-gray-300" />
              Fetching available options…
            </div>
          ) : configError ? (
            <ErrorNotice
              message={configError}
              textClassName="text-sm text-red-400"
            />
          ) : configWithPricing ? (
            <div className="space-y-6">
              {configWithPricing.fields
                .filter((f) => evaluateShowWhen(f, fields))
                .map((f) => (
                  <FieldRenderer key={f.key} field={f} value={fields[f.key] ?? ""} onChange={(v) => setField(f.key, v)} />
                ))}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0">
          {error && (
            <ErrorNotice
              message={error}
              className="mb-3 rounded bg-red-900/20 px-3 py-2"
              textClassName="text-xs text-red-400"
            />
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || loadingConfig || !!configError}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {creating ? "Creating…" : `Create ${resourceType.displayName}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
