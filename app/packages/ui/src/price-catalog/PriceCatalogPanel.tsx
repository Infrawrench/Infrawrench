import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  PRICE_CATALOG_AREA_LABELS,
  PRICE_CATALOG_AREA_LIST,
  PRICE_RATE_TYPES,
  PRICE_RATE_TYPE_LABELS,
  formatCatalogAmount,
  formatCatalogMonthly,
  formatCatalogRateType,
  formatCatalogSpecs,
  formatCatalogUnit,
  renderableHelpUrl,
  type PriceCatalogArea,
  type PriceCatalogCompareQuery,
  type PriceCatalogCompareResponse,
  type PriceCatalogGpuFilter,
  type PriceCatalogProviderStatus,
  type PriceCatalogRow,
  type PriceCatalogSearchQuery,
  type PriceCatalogSearchResponse,
  type PriceCatalogSort,
  type PriceRateType,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

/** What the panel needs from its host: three reads, no writes. */
export interface PriceCatalogClient {
  search(query: PriceCatalogSearchQuery): Promise<PriceCatalogSearchResponse>;
  compare(query: PriceCatalogCompareQuery): Promise<PriceCatalogCompareResponse>;
}

/** An org account the "use in estimate" action can create through. */
export interface PriceCatalogAccount {
  id: string;
  pluginId: string;
  displayName: string;
}

export interface PriceCatalogEstimateTarget {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  fields: Record<string, string>;
  /** `m7i.large in us-east-1`, for the modal's title. */
  label: string;
}

export interface PriceCatalogPanelProps {
  client: PriceCatalogClient;
  /**
   * The org's accounts. A row's "Use in estimate" is offered only when the
   * org has an account on that row's plugin, because the create form (and
   * its estimate) is per account.
   */
  accounts?: PriceCatalogAccount[] | undefined;
  /** Open the host's create form prefilled; the estimate badge does the rest. */
  onUseInEstimate?: ((target: PriceCatalogEstimateTarget) => void) | undefined;
  onOpenExternal?: ((url: string) => void) | undefined;
}

const inputClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
const PAGE = 100;

type Mode = "search" | "compare";

function numOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function rowMonthly(row: PriceCatalogRow): string {
  if (row.monthlyAmount === null) return "";
  return formatCatalogMonthly(row.monthlyAmount, row.price.currency);
}

/**
 * Which providers did not contribute and why. Rendered above the table and
 * never collapsed, because a short list *is* what these explain: without it,
 * "AWS has nothing under $50" and "AWS was not searched" look the same.
 */
function CoverageNotes({
  providers,
  onOpenExternal,
}: {
  providers: PriceCatalogProviderStatus[];
  onOpenExternal?: ((url: string) => void) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const noAccount = providers.filter((p) => p.state === "no-account");
  const loading = providers.filter((p) => p.state === "loading");
  const failed = providers.filter((p) => p.state === "error");
  const truncated = providers.filter((p) => p.state === "ready" && p.truncated);
  const stale = providers.filter((p) => p.state === "ready" && p.error);
  if (noAccount.length + loading.length + failed.length + truncated.length + stale.length === 0) {
    return null;
  }
  const names = (list: PriceCatalogProviderStatus[]) =>
    list.map((p) => gtData(p.pluginName)).join(", ");
  return (
    <div className="mb-4 flex flex-col gap-1.5 text-xs">
      {noAccount.length > 0 && (
        <T>
          <p className="text-on-surface-faint">
            Not searched (their price APIs need a connected account): <Var>{names(noAccount)}</Var>.
          </p>
        </T>
      )}
      {loading.length > 0 && (
        <T>
          <p role="status" className="text-on-surface-faint">
            Still fetching price lists from <Var>{names(loading)}</Var>. Refresh in a moment.
          </p>
        </T>
      )}
      {failed.map((p) => (
        <T key={p.pluginId}>
          <p role="alert" className="text-danger">
            <Var>{gtData(p.pluginName)}</Var> prices could not be read: <Var>{p.error}</Var>
            <Var>
              {p.permission ? (
                <span className="text-on-surface-faint">
                  {" "}
                  {gt("(needs {permission})", { permission: p.permission })}
                </span>
              ) : null}
            </Var>
          </p>
        </T>
      ))}
      {stale.map((p) => (
        <T key={`stale-${p.pluginId}`}>
          <p className="text-warning">
            <Var>{gtData(p.pluginName)}</Var> could not refresh, showing the last price list
            fetched: <Var>{p.error}</Var>
          </p>
        </T>
      ))}
      {truncated.length > 0 && (
        <T>
          <p className="text-warning">
            <Var>{names(truncated)}</Var> returned more products than one fetch reads; the list for
            them is incomplete.
          </p>
        </T>
      )}
      {onOpenExternal && (
        <p className="text-on-surface-faint">
          {gt("Sources:")}{" "}
          {providers
            .filter((p) => renderableHelpUrl(p.source.url))
            .map((p, i) => (
              <span key={p.pluginId}>
                {i > 0 ? ", " : ""}
                <button
                  type="button"
                  className="underline"
                  onClick={() => onOpenExternal(renderableHelpUrl(p.source.url)!)}
                >
                  {gtData(p.source.name)}
                </button>
              </span>
            ))}
        </p>
      )}
    </div>
  );
}

/** "Use in estimate", with an inline account choice when there are several. */
function UseInEstimateButton({
  row,
  accounts,
  onUseInEstimate,
}: {
  row: PriceCatalogRow;
  accounts: PriceCatalogAccount[];
  onUseInEstimate: (target: PriceCatalogEstimateTarget) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const candidates = accounts.filter((a) => a.pluginId === row.pluginId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!row.estimate) return null;
  const estimate = row.estimate;
  const fire = (accountId: string) => {
    setOpen(false);
    onUseInEstimate({
      accountId,
      pluginId: row.pluginId,
      resourceTypeId: estimate.resourceTypeId,
      fields: estimate.fields,
      label: `${row.name} · ${row.regionLabel}`,
    });
  };
  if (candidates.length === 0) {
    return (
      <span
        className="text-xs text-on-surface-faint"
        title={gt("Connect an account on this provider to open its create form.")}
      >
        {gt("No account")}
      </span>
    );
  }
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className="text-xs text-accent hover:underline whitespace-nowrap"
        onClick={() => (candidates.length === 1 ? fire(candidates[0]!.id) : setOpen((v) => !v))}
      >
        {gt("Use in estimate")}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-48 rounded-lg border border-border bg-surface-raised p-1 shadow-lg"
        >
          <p className="px-2 py-1 text-[11px] text-on-surface-faint">{gt("Create through")}</p>
          {candidates.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-overlay"
              onClick={() => fire(a.id)}
            >
              {a.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OtherPrices({ row }: { row: PriceCatalogRow }) {
  const gtData = useDataString();
  if (row.otherPrices.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-on-surface-faint">
      {row.otherPrices.map((p, i) => (
        <span key={i} className="tabular-nums">
          {gtData(formatCatalogRateType(p))}: {formatCatalogAmount(p.amount, p.currency)}
          {formatCatalogUnit(p.unit)}
        </span>
      ))}
    </div>
  );
}

/**
 * The Price catalog: every catalog provider's published list prices, with
 * search, filters, a cross-provider comparison and a way into the create
 * form's estimate for any row. Shared by web and desktop (cloud mode).
 */
export function PriceCatalogPanel({
  client,
  accounts = [],
  onUseInEstimate,
  onOpenExternal,
}: PriceCatalogPanelProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [mode, setMode] = useState<Mode>("search");

  // Search state
  const [q, setQ] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [area, setArea] = useState<PriceCatalogArea>("north-america");
  const [region, setRegion] = useState("");
  const [rateType, setRateType] = useState<PriceRateType>("on-demand");
  const [minVcpus, setMinVcpus] = useState("");
  const [maxVcpus, setMaxVcpus] = useState("");
  const [minMemory, setMinMemory] = useState("");
  const [maxMemory, setMaxMemory] = useState("");
  const [gpu, setGpu] = useState<PriceCatalogGpuFilter>("any");
  const [gpuModel, setGpuModel] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState<PriceCatalogSort>("price");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(PAGE);
  const [reloadKey, setReloadKey] = useState(0);

  const [data, setData] = useState<PriceCatalogSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = useMemo<PriceCatalogSearchQuery>(
    () => ({
      q: q.trim() || undefined,
      pluginIds: pluginId ? [pluginId] : undefined,
      area,
      region: pluginId && region ? region : undefined,
      rateType,
      minVcpus: numOrUndefined(minVcpus),
      maxVcpus: numOrUndefined(maxVcpus),
      minMemoryGb: numOrUndefined(minMemory),
      maxMemoryGb: numOrUndefined(maxMemory),
      gpu,
      gpuModel: gpuModel || undefined,
      maxMonthlyPrice: numOrUndefined(maxPrice),
      sort,
      order,
      limit,
    }),
    [
      q,
      pluginId,
      area,
      region,
      rateType,
      minVcpus,
      maxVcpus,
      minMemory,
      maxMemory,
      gpu,
      gpuModel,
      maxPrice,
      sort,
      order,
      limit,
    ],
  );
  const debouncedQuery = useDebounced(query, 300);

  useEffect(() => {
    if (mode !== "search") return;
    let cancelled = false;
    setLoading(true);
    client
      .search(debouncedQuery)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : gt("Request failed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, debouncedQuery, mode, reloadKey, gt]);

  // Compare state
  const [cVcpus, setCVcpus] = useState("4");
  const [cMemory, setCMemory] = useState("16");
  const [cGpus, setCGpus] = useState("");
  const [cGpuModel, setCGpuModel] = useState("");
  const [reference, setReference] = useState<PriceCatalogRow | null>(null);
  const [compare, setCompare] = useState<PriceCatalogCompareResponse | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const compareQuery = useMemo<PriceCatalogCompareQuery>(
    () =>
      reference
        ? {
            reference: { pluginId: reference.pluginId, sku: reference.sku },
            area,
            rateType,
          }
        : {
            vcpus: numOrUndefined(cVcpus),
            memoryGb: numOrUndefined(cMemory),
            gpuCount: numOrUndefined(cGpus),
            gpuModel: cGpuModel || undefined,
            area,
            rateType,
          },
    [reference, cVcpus, cMemory, cGpus, cGpuModel, area, rateType],
  );
  const debouncedCompare = useDebounced(compareQuery, 300);

  useEffect(() => {
    if (mode !== "compare") return;
    let cancelled = false;
    setComparing(true);
    client
      .compare(debouncedCompare)
      .then((res) => {
        if (cancelled) return;
        setCompare(res);
        setCompareError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setCompareError(e instanceof Error ? e.message : gt("Request failed"));
      })
      .finally(() => {
        if (!cancelled) setComparing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, debouncedCompare, mode, reloadKey, gt]);

  const providers = data?.providers ?? [];
  const selectedProvider = providers.find((p) => p.pluginId === pluginId);

  const toggleSort = useCallback(
    (next: PriceCatalogSort) => {
      if (sort === next) setOrder((o) => (o === "asc" ? "desc" : "asc"));
      else {
        setSort(next);
        setOrder(next === "price" || next === "name" ? "asc" : "desc");
      }
    },
    [sort],
  );

  const compareFrom = (row: PriceCatalogRow) => {
    setReference(row);
    setMode("compare");
  };

  const sortIndicator = (key: PriceCatalogSort) =>
    sort === key ? (order === "asc" ? " ↑" : " ↓") : "";

  const estimateCell = (row: PriceCatalogRow) =>
    onUseInEstimate ? (
      <UseInEstimateButton row={row} accounts={accounts} onUseInEstimate={onUseInEstimate} />
    ) : null;

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Price catalog")}</h1>
      <p className="text-sm text-on-surface-muted mb-4">
        {gt(
          "Search and compare providers' published list prices. Your discounts, credits and negotiated rates are not applied.",
        )}
      </p>

      <div className="mb-4 flex items-center gap-1" role="tablist">
        {(
          [
            ["search", gt("Search")],
            ["compare", gt("Compare providers")],
          ] as Array<[Mode, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              mode === key
                ? "bg-surface-overlay text-on-surface font-medium"
                : "text-on-surface-muted hover:text-on-surface"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="ml-auto text-xs text-on-surface-muted hover:text-on-surface underline"
        >
          {gt("Refresh")}
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className={labelClass} htmlFor="pc-area">
            {gt("Area")}
          </label>
          <select
            id="pc-area"
            className={inputClass}
            value={area}
            onChange={(e) => {
              setArea(e.target.value as PriceCatalogArea);
              setRegion("");
            }}
          >
            {PRICE_CATALOG_AREA_LIST.map((a) => (
              <option key={a} value={a}>
                {gtData(PRICE_CATALOG_AREA_LABELS[a])}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="pc-rate">
            {gt("Rate")}
          </label>
          <select
            id="pc-rate"
            className={inputClass}
            value={rateType}
            onChange={(e) => setRateType(e.target.value as PriceRateType)}
          >
            {PRICE_RATE_TYPES.map((r) => (
              <option key={r} value={r}>
                {gtData(PRICE_RATE_TYPE_LABELS[r])}
              </option>
            ))}
          </select>
        </div>
        {mode === "search" && (
          <>
            <div>
              <label className={labelClass} htmlFor="pc-q">
                {gt("Search")}
              </label>
              <input
                id="pc-q"
                className={`${inputClass} w-48`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={gt("Instance type, family, GPU")}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="pc-provider">
                {gt("Provider")}
              </label>
              <select
                id="pc-provider"
                className={inputClass}
                value={pluginId}
                onChange={(e) => {
                  setPluginId(e.target.value);
                  setRegion("");
                }}
              >
                <option value="">{gt("All providers")}</option>
                {providers.map((p) => (
                  <option key={p.pluginId} value={p.pluginId}>
                    {gtData(p.pluginName)}
                  </option>
                ))}
              </select>
            </div>
            {selectedProvider && (
              <div>
                <label className={labelClass} htmlFor="pc-region">
                  {gt("Region")}
                </label>
                <select
                  id="pc-region"
                  className={inputClass}
                  value={region || selectedProvider.region || ""}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  {selectedProvider.regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <span className={labelClass}>{gt("vCPUs")}</span>
              <div className="flex items-center gap-1">
                <input
                  aria-label={gt("Minimum vCPUs")}
                  className={`${inputClass} w-16`}
                  inputMode="numeric"
                  value={minVcpus}
                  onChange={(e) => setMinVcpus(e.target.value)}
                  placeholder={gt("min")}
                />
                <input
                  aria-label={gt("Maximum vCPUs")}
                  className={`${inputClass} w-16`}
                  inputMode="numeric"
                  value={maxVcpus}
                  onChange={(e) => setMaxVcpus(e.target.value)}
                  placeholder={gt("max")}
                />
              </div>
            </div>
            <div>
              <span className={labelClass}>{gt("Memory (GB)")}</span>
              <div className="flex items-center gap-1">
                <input
                  aria-label={gt("Minimum memory in GB")}
                  className={`${inputClass} w-16`}
                  inputMode="decimal"
                  value={minMemory}
                  onChange={(e) => setMinMemory(e.target.value)}
                  placeholder={gt("min")}
                />
                <input
                  aria-label={gt("Maximum memory in GB")}
                  className={`${inputClass} w-16`}
                  inputMode="decimal"
                  value={maxMemory}
                  onChange={(e) => setMaxMemory(e.target.value)}
                  placeholder={gt("max")}
                />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor="pc-gpu">
                {gt("GPU")}
              </label>
              <select
                id="pc-gpu"
                className={inputClass}
                value={gpu}
                onChange={(e) => setGpu(e.target.value as PriceCatalogGpuFilter)}
              >
                <option value="any">{gt("Any")}</option>
                <option value="required">{gt("With GPU")}</option>
                <option value="none">{gt("Without GPU")}</option>
              </select>
            </div>
            {gpu !== "none" && (data?.gpuModels.length ?? 0) > 0 && (
              <div>
                <label className={labelClass} htmlFor="pc-gpu-model">
                  {gt("GPU model")}
                </label>
                <select
                  id="pc-gpu-model"
                  className={inputClass}
                  value={gpuModel}
                  onChange={(e) => setGpuModel(e.target.value)}
                >
                  <option value="">{gt("Any model")}</option>
                  {data!.gpuModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor="pc-max-price">
                {gt("Max per month")}
              </label>
              <input
                id="pc-max-price"
                className={`${inputClass} w-24`}
                inputMode="decimal"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      {mode === "search" && (
        <>
          {error != null && (
            <T>
              <p role="alert" className="mb-3 text-sm text-danger">
                Couldn&apos;t load the price catalog: <Var>{error}</Var>
              </p>
            </T>
          )}
          {data === null && error == null && (
            <p role="status" className="text-sm text-on-surface-faint">
              {gt("Fetching price lists…")}
            </p>
          )}
          {data !== null && (
            <>
              <CoverageNotes providers={data.providers} onOpenExternal={onOpenExternal} />
              {data.mixedCurrencies && (
                <p className="mb-3 text-xs text-warning">
                  {gt(
                    "Prices are in several currencies ({currencies}) and sort by face value. Set a display currency in Settings to compare them.",
                    { currencies: data.currencies.join(", ") },
                  )}
                </p>
              )}
              <p className="mb-2 text-xs text-on-surface-faint" role="status">
                {loading
                  ? gt("Updating…")
                  : gt("{shown} of {total} instance types", {
                      shown: data.rows.length,
                      total: data.total,
                    })}
              </p>
              {data.rows.length === 0 ? (
                <p className="text-sm text-on-surface-faint">
                  {gt("Nothing in the catalog matches these filters.")}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-on-surface-faint">
                        <th className="px-4 py-2 font-medium">
                          <button type="button" onClick={() => toggleSort("name")}>
                            {gt("Instance")}
                            {sortIndicator("name")}
                          </button>
                        </th>
                        <th className="px-3 py-2 font-medium">
                          <button type="button" onClick={() => toggleSort("vcpus")}>
                            {gt("Specs")}
                            {sortIndicator("vcpus")}
                          </button>
                        </th>
                        <th className="px-3 py-2 font-medium">{gt("Region")}</th>
                        <th className="px-3 py-2 font-medium text-right">{gt("Rate")}</th>
                        <th className="px-3 py-2 font-medium text-right">
                          <button type="button" onClick={() => toggleSort("price")}>
                            {gt("Per month")}
                            {sortIndicator("price")}
                          </button>
                        </th>
                        <th className="px-3 py-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr
                          key={`${row.pluginId}:${row.sku}:${row.region}`}
                          className="border-b border-border last:border-b-0 align-top"
                        >
                          <td className="px-4 py-2">
                            <div className="font-medium">{row.name}</div>
                            <div className="text-xs text-on-surface-faint">
                              {gtData(row.pluginName)} · {gtData(row.serviceLabel)}
                              {row.series ? ` · ${row.series}` : ""}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-on-surface-secondary">
                            {formatCatalogSpecs(row.specs)}
                          </td>
                          <td className="px-3 py-2 text-xs">{row.regionLabel}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <div>
                              {formatCatalogAmount(row.price.amount, row.price.currency)}
                              {formatCatalogUnit(row.price.unit)}
                            </div>
                            <div className="text-[11px] text-on-surface-faint">
                              {gtData(formatCatalogRateType(row.price))}
                            </div>
                            <OtherPrices row={row} />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <div className="font-medium">{rowMonthly(row)}</div>
                            {row.comparable && row.comparable.currency !== row.price.currency && (
                              <div className="text-[11px] text-on-surface-faint">
                                {formatCatalogMonthly(
                                  row.comparable.amount,
                                  row.comparable.currency,
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex flex-col items-end gap-1">
                              <button
                                type="button"
                                className="text-xs text-accent hover:underline whitespace-nowrap"
                                onClick={() => compareFrom(row)}
                              >
                                {gt("Compare")}
                              </button>
                              {estimateCell(row)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.total > data.rows.length && (
                <button
                  type="button"
                  className="mt-3 text-sm text-accent hover:underline"
                  onClick={() => setLimit((l) => l + PAGE)}
                >
                  {gt("Show more")}
                </button>
              )}
            </>
          )}
        </>
      )}

      {mode === "compare" && (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            {reference ? (
              <T>
                <p className="text-sm">
                  Equivalents of <Var>{reference.name}</Var> (
                  <Var>{formatCatalogSpecs(reference.specs)}</Var>){" "}
                  <Var>
                    <button
                      type="button"
                      className="text-xs text-accent underline"
                      onClick={() => setReference(null)}
                    >
                      {gt("Enter specs instead")}
                    </button>
                  </Var>
                </p>
              </T>
            ) : (
              <>
                <div>
                  <label className={labelClass} htmlFor="pc-c-vcpus">
                    {gt("At least vCPUs")}
                  </label>
                  <input
                    id="pc-c-vcpus"
                    className={`${inputClass} w-20`}
                    inputMode="numeric"
                    value={cVcpus}
                    onChange={(e) => setCVcpus(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="pc-c-memory">
                    {gt("At least memory (GB)")}
                  </label>
                  <input
                    id="pc-c-memory"
                    className={`${inputClass} w-20`}
                    inputMode="decimal"
                    value={cMemory}
                    onChange={(e) => setCMemory(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="pc-c-gpus">
                    {gt("GPUs")}
                  </label>
                  <input
                    id="pc-c-gpus"
                    className={`${inputClass} w-16`}
                    inputMode="numeric"
                    value={cGpus}
                    onChange={(e) => setCGpus(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="pc-c-gpu-model">
                    {gt("GPU model")}
                  </label>
                  <input
                    id="pc-c-gpu-model"
                    className={`${inputClass} w-28`}
                    value={cGpuModel}
                    onChange={(e) => setCGpuModel(e.target.value)}
                    placeholder={gt("e.g. L4")}
                  />
                </div>
              </>
            )}
          </div>
          {compareError != null && (
            <T>
              <p role="alert" className="mb-3 text-sm text-danger">
                Couldn&apos;t compare: <Var>{compareError}</Var>
              </p>
            </T>
          )}
          {compare === null && compareError == null && (
            <p role="status" className="text-sm text-on-surface-faint">
              {gt("Fetching price lists…")}
            </p>
          )}
          {compare !== null && (
            <>
              {comparing && (
                <p role="status" className="mb-2 text-xs text-on-surface-faint">
                  {gt("Updating…")}
                </p>
              )}
              {compare.mixedCurrencies && (
                <p className="mb-3 text-xs text-warning">
                  {gt(
                    "Providers quote in different currencies, ordered by face value. Set a display currency in Settings to compare them.",
                  )}
                </p>
              )}
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-on-surface-faint">
                      <th className="px-4 py-2 font-medium">{gt("Provider")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Cheapest match")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Specs")}</th>
                      <th className="px-3 py-2 font-medium text-right">{gt("Per month")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Runners-up")}</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {compare.providers.map((p) => (
                      <tr
                        key={p.pluginId}
                        className="border-b border-border last:border-b-0 align-top"
                      >
                        <td className="px-4 py-2">
                          <div className="font-medium">{gtData(p.pluginName)}</div>
                          <div className="text-xs text-on-surface-faint">{p.regionLabel ?? ""}</div>
                        </td>
                        {p.best ? (
                          <>
                            <td className="px-3 py-2">{p.best.name}</td>
                            <td className="px-3 py-2 text-xs text-on-surface-secondary">
                              {formatCatalogSpecs(p.best.specs)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">
                              {rowMonthly(p.best)}
                            </td>
                            <td className="px-3 py-2 text-xs text-on-surface-faint">
                              {p.alternatives.map((a) => `${a.name} ${rowMonthly(a)}`).join(", ")}
                            </td>
                            <td className="px-3 py-2 text-right">{estimateCell(p.best)}</td>
                          </>
                        ) : (
                          <td colSpan={5} className="px-3 py-2 text-xs text-on-surface-faint">
                            {p.state === "no-account"
                              ? gt("Not searched: this provider's price API needs an account.")
                              : p.state === "no-region"
                                ? gt("No region in this area.")
                                : p.state === "loading"
                                  ? gt("Still fetching; refresh in a moment.")
                                  : p.state === "error"
                                    ? gt("Prices could not be read: {error}", {
                                        error: p.error ?? "",
                                      })
                                    : gt("Nothing meets every spec at this rate.")}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
