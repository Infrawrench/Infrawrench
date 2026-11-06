import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useGT, useLocale } from "gt-react";
import { camelToTitle, type InstancePricingCapability } from "@infrawrench/plugin-base";
import {
  INSTANCE_HOURS_PER_MONTH,
  INSTANCE_PRICING_MAX_ROWS,
  attributeChangesSql,
  defaultInstanceTerm,
  familySizesSql,
  instanceFreshnessSql,
  instanceLeaseMonths,
  instancePriceSteps,
  instancePricingPageUrl,
  instancePricingRows,
  instanceRegionCountSteps,
  instanceSpecsSql,
  instanceTermKey,
  offerMatchesSelection,
  offeredRegionsSql,
  onDemandByRegionSql,
  parseInstanceOffers,
  priceHistorySql,
  regionNamesSql,
  regionOffersSql,
  resolveInstanceSelection,
  spotByRegionSql,
  spotHistorySql,
  type InstancePriceOffer,
  type InstancePricingQuery,
  type InstancePricingResult,
} from "@infrawrench/client-core";
import { useDataString } from "../../i18n/data-strings.js";
import { BarList } from "../charts/BarList.js";
import { StepSeriesChart, type StepSeries } from "../charts/StepSeriesChart.js";
import { ChevronIcon, ExternalLinkIcon, RefreshIcon } from "../icons/ChromeIcons.js";

const OPEN_KEY = "infrawrench-instance-pricing-open";
const DAY = 86_400;
const CACHE_MS = 10 * 60_000;

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private windows and blocked storage: it just opens collapsed next time.
  }
}

/**
 * Results by statement, shared across resource pages: the same instance type on
 * ten pages is one set of queries, and going back to a region repeats nothing.
 */
const results = new Map<string, { at: number; promise: Promise<InstancePricingResult> }>();

function cachedQuery(query: InstancePricingQuery, sql: string): Promise<InstancePricingResult> {
  const hit = results.get(sql);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = query(sql, INSTANCE_PRICING_MAX_ROWS);
  results.set(sql, { at: Date.now(), promise });
  promise.catch(() => results.delete(sql));
  return promise;
}

interface WarehouseState {
  /** The newest result, kept while a new statement loads so the panel does not jump. */
  result: InstancePricingResult | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** One statement's result; a null statement waits for what it depends on. */
function useWarehouse(query: InstancePricingQuery, sql: string | null): WarehouseState {
  const [settled, setSettled] = useState<{
    sql: string;
    result: InstancePricingResult | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sql) return;
    let cancelled = false;
    cachedQuery(query, sql).then(
      (result) => {
        if (!cancelled) setSettled({ sql, result, error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setSettled({
            sql,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, sql, attempt]);

  const current = settled?.sql === sql;
  return {
    result: settled?.result ?? null,
    loading: !current,
    error: current ? (settled?.error ?? null) : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

const NO_ROWS: ReturnType<typeof instancePricingRows> = [];

function useRows(state: WarehouseState) {
  return useMemo(() => (state.result ? instancePricingRows(state.result) : []), [state.result]);
}

type Period = "hourly" | "monthly";

function dimensionLabel(
  gt: ReturnType<typeof useGT>,
  tr: (value: string) => string,
  key: string,
): string {
  switch (key) {
    case "operating_system":
      return gt("Operating system");
    case "tenancy":
      return gt("Tenancy");
    case "license_model":
      return gt("License model");
    case "pre_installed_sw":
      return gt("Pre-installed software");
    case "capacity_status":
      return gt("Capacity status");
    case "database_engine":
      return gt("Database engine");
    case "database_edition":
      return gt("Database edition");
    case "deployment_option":
      return gt("Deployment option");
    case "deployment_model":
      return gt("Deployment model");
    case "engine_media_type":
      return gt("Engine media type");
    case "cache_engine":
      return gt("Cache engine");
    case "software_type":
      return gt("Software type");
    case "component":
      return gt("Component");
    default:
      return tr(camelToTitle(key.replace(/^variant\./, "")));
  }
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-on-surface-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 truncate rounded border border-border-strong bg-surface-overlay px-2 py-1 text-xs text-on-surface"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PriceCard({
  label,
  price,
  saving,
  note,
}: {
  label: string;
  price: string;
  saving?: string | undefined;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-3 py-2">
      <div className="truncate text-xs text-on-surface-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-on-surface">{price}</div>
      <div className="text-xs text-on-surface-faint">
        {note}
        {saving && ` · ${saving}`}
      </div>
    </div>
  );
}

function Section({
  title,
  state,
  children,
}: {
  title: ReactNode;
  state?: WarehouseState | undefined;
  children: ReactNode;
}) {
  const gt = useGT();
  return (
    <section aria-busy={state?.loading ?? false} className="min-w-0">
      <h3 className="mb-2 text-sm font-medium text-on-surface-secondary">{title}</h3>
      {state?.error ? (
        <p className="flex items-center gap-2 text-xs text-on-surface-muted">
          {gt("This couldn't be loaded.")}
          <button
            type="button"
            onClick={state.retry}
            className="inline-flex items-center gap-1 text-accent hover:text-accent-hover"
          >
            <RefreshIcon size={12} />
            {gt("Try again")}
          </button>
        </p>
      ) : (
        <div className={`transition-opacity ${state?.loading ? "opacity-50" : ""}`}>{children}</div>
      )}
    </section>
  );
}

function SpecList({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-on-surface-muted">{label}</dt>
          <dd className="min-w-0 break-words text-on-surface">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PanelBody({
  capability,
  query,
}: {
  capability: InstancePricingCapability;
  query: InstancePricingQuery;
}) {
  const gt = useGT();
  const tr = useDataString();
  const locale = useLocale();
  const { platform, instanceTypes } = capability;

  const [instanceType, setInstanceType] = useState(instanceTypes[0] ?? "");
  const [regionChoice, setRegionChoice] = useState(capability.region ?? "");
  const [picked, setPicked] = useState<Record<string, string>>(capability.selection ?? {});
  const [termChoice, setTermChoice] = useState("");
  const [period, setPeriod] = useState<Period>("hourly");
  const [compareChoice, setCompareChoice] = useState("");
  // The newest pick goes first: it wins over older ones it cannot sit with.
  const pick = (key: string, value: string) =>
    setPicked((p) => {
      const rest = Object.fromEntries(Object.entries(p).filter(([k]) => k !== key));
      return { [key]: value, ...rest };
    });

  const regionsQuery = useWarehouse(query, offeredRegionsSql(platform, instanceType));
  const specsQuery = useWarehouse(query, instanceSpecsSql(platform, instanceType));
  const namesQuery = useWarehouse(query, regionNamesSql(platform));
  const freshnessQuery = useWarehouse(query, instanceFreshnessSql(platform));

  const regionRows = useRows(regionsQuery);
  const regions = useMemo(() => regionRows.map((r) => String(r["region"])), [regionRows]);
  const nameRows = useRows(namesQuery);
  const names = useMemo(
    () => new Map(nameRows.map((r) => [String(r["region"]), String(r["location"])])),
    [nameRows],
  );
  const region = regions.includes(regionChoice) ? regionChoice : (regions[0] ?? "");
  const regionName = names.get(region) ?? region;
  const oneRegion = regions.length <= 1;
  const regionReady = !regionsQuery.loading && region !== "";

  const offersQuery = useWarehouse(
    query,
    regionReady ? regionOffersSql(platform, instanceType, region) : null,
  );
  const offers = useMemo(
    () => (offersQuery.result ? parseInstanceOffers(offersQuery.result) : []),
    [offersQuery.result],
  );
  const { selection, choices } = useMemo(
    () => resolveInstanceSelection(offers, picked),
    [offers, picked],
  );
  const ready = regionReady && !offersQuery.loading && offers.length > 0;
  const hasSpot = offers.some((o) => o.pricing === "spot");
  const specs = useRows(specsQuery)[0];
  const family = typeof specs?.["family"] === "string" ? specs["family"] : "";

  const historyQuery = useWarehouse(
    query,
    ready ? priceHistorySql(platform, instanceType, region, selection) : null,
  );
  const spotHistoryQuery = useWarehouse(
    query,
    ready && hasSpot ? spotHistorySql(platform, instanceType, region, selection) : null,
  );
  const byRegionQuery = useWarehouse(
    query,
    ready ? onDemandByRegionSql(platform, instanceType, selection) : null,
  );
  const spotByRegionQuery = useWarehouse(
    query,
    ready && hasSpot ? spotByRegionSql(platform, instanceType, selection) : null,
  );
  const familyQuery = useWarehouse(
    query,
    ready && family ? familySizesSql(platform, family, region, selection) : null,
  );
  const changesQuery = useWarehouse(
    query,
    regionReady ? attributeChangesSql(platform, instanceType, region) : null,
  );

  const money = useMemo(
    () => (hourly: number) =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: hourly < 1 ? 4 : 2,
      }).format(hourly),
    [locale],
  );
  const inPeriod = (hourly: number) =>
    period === "monthly" ? money(hourly * INSTANCE_HOURS_PER_MONTH) : money(hourly);
  const periodNote = period === "monthly" ? gt("per month") : gt("per hour");

  const matching = useMemo(
    () => offers.filter((o) => offerMatchesSelection(o, selection)),
    [offers, selection],
  );
  const lowest = (rows: readonly InstancePriceOffer[]) =>
    rows.length === 0 ? null : Math.min(...rows.map((o) => o.effective));
  const onDemand = lowest(matching.filter((o) => o.pricing === "on_demand"));
  const spot = lowest(matching.filter((o) => o.pricing === "spot"));
  const committed = useMemo(() => matching.filter((o) => o.pricing === "reserved"), [matching]);
  const termKeys = useMemo(() => [...new Set(committed.map(instanceTermKey))].sort(), [committed]);
  const term = termKeys.includes(termChoice) ? termChoice : defaultInstanceTerm(termKeys);
  const termLeases = useMemo(() => {
    const byLease = new Map<string, InstancePriceOffer>();
    for (const offer of committed) {
      if (instanceTermKey(offer) !== term) continue;
      const known = byLease.get(offer.lease);
      if (!known || offer.effective < known.effective) byLease.set(offer.lease, offer);
    }
    return [...byLease.values()].sort(
      (a, b) => instanceLeaseMonths(a.lease) - instanceLeaseMonths(b.lease),
    );
  }, [committed, term]);
  // A rounded "0% off" says nothing a matching price does not already say.
  const savingOn = (price: number) =>
    onDemand && onDemand > 0 && 1 - price / onDemand >= 0.005
      ? gt("{percent} off on demand", {
          percent: new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 0,
          }).format(1 - price / onDemand),
        })
      : undefined;

  const now = Math.floor(Date.now() / 1000);
  const retiredAt =
    typeof specs?.["retired_at"] === "string" ? parseWarehouseTime(specs["retired_at"]) : null;
  const historyEnd = retiredAt ?? now;

  const historyRows = useRows(historyQuery);
  // Hooks keep their last result while waiting, so a type with no spot prices
  // must not go on showing the previous type's.
  const spotHistoryRows = useRows(spotHistoryQuery);
  const spotRows = hasSpot ? spotHistoryRows : NO_ROWS;
  const history = useMemo<StepSeries[]>(() => {
    const periods = (rows: typeof historyRows) =>
      rows.map((r) => ({
        validFrom: Number(r["validFrom"]),
        validTo: r["validTo"] === null ? null : Number(r["validTo"]),
        price: Number(r["price"]),
      }));
    const series: StepSeries[] = [
      {
        id: "onDemand",
        label: gt("On demand"),
        points: instancePriceSteps(
          periods(historyRows.filter((r) => r["pricing"] === "on_demand")),
        ),
      },
    ];
    if (spotRows.length > 0) {
      series.push({
        id: "spot",
        label: gt("Spot"),
        points: spotRows.map((r) => [Number(r["at"]), Number(r["price"])] as const),
      });
    }
    for (const offer of termLeases) {
      const rows = historyRows.filter(
        (r) =>
          r["pricing"] === "reserved" &&
          r["lease"] === offer.lease &&
          `${String(r["offering_class"])}|${String(r["purchase_option"])}` === term,
      );
      series.push({
        id: `term${offer.lease}`,
        label: offer.lease,
        points: instancePriceSteps(periods(rows)),
      });
    }
    return series;
  }, [historyRows, spotRows, termLeases, term, gt]);

  const byRegionRows = useRows(byRegionQuery);
  const regionBars = useMemo(() => {
    const prices = new Map<string, number>();
    for (const r of byRegionRows) {
      if (r["validTo"] !== null) continue;
      const code = String(r["region"]);
      const price = Number(r["price"]);
      const known = prices.get(code);
      if (known === undefined || price < known) prices.set(code, price);
    }
    return [...prices]
      .map(([code, value]) => ({
        id: code,
        label: names.get(code) ?? code,
        detail: names.has(code) && names.get(code) !== code ? code : undefined,
        value,
        selected: code === region,
      }))
      .sort((a, b) => a.value - b.value);
  }, [byRegionRows, names, region]);
  const spotRegionRows = useRows(spotByRegionQuery);
  const spotBars = useMemo(
    () =>
      (hasSpot ? spotRegionRows : NO_ROWS)
        .map((r) => {
          const code = String(r["region"]);
          return {
            id: code,
            label: names.get(code) ?? code,
            detail: names.has(code) && names.get(code) !== code ? code : undefined,
            value: Number(r["price"]),
            selected: code === region,
          };
        })
        .sort((a, b) => a.value - b.value),
    [hasSpot, spotRegionRows, names, region],
  );
  const availability = useMemo(
    () =>
      instanceRegionCountSteps(
        byRegionRows.map((r) => ({
          region: String(r["region"]),
          validFrom: Number(r["validFrom"]),
          validTo: r["validTo"] === null ? null : Number(r["validTo"]),
          price: Number(r["price"]),
        })),
      ),
    [byRegionRows],
  );

  const compareKey = choices.some((c) => c.key === compareChoice)
    ? compareChoice
    : (choices[0]?.key ?? "");
  const compareBars = useMemo(() => {
    const others = Object.fromEntries(Object.entries(selection).filter(([k]) => k !== compareKey));
    const prices = new Map<string, number>();
    for (const offer of offers) {
      const value = offer.dimensions[compareKey];
      if (offer.pricing !== "on_demand" || value === undefined) continue;
      if (!offerMatchesSelection(offer, others)) continue;
      const known = prices.get(value);
      if (known === undefined || offer.effective < known) prices.set(value, offer.effective);
    }
    return [...prices]
      .map(([value, price]) => ({
        id: value,
        label: tr(value),
        value: price,
        selected: selection[compareKey] === value,
      }))
      .sort((a, b) => a.value - b.value);
  }, [offers, selection, compareKey, tr]);

  const familyRows = useRows(familyQuery);
  const changeRows = useRows(changesQuery);
  const changes = useMemo(() => {
    const byAttribute = new Map<string, { at: number; value: string | null }[]>();
    for (const r of changeRows) {
      const attribute = String(r["attribute"]);
      const entry = {
        at: Number(r["at"]),
        value: typeof r["value"] === "string" ? r["value"] : null,
      };
      const known = byAttribute.get(attribute);
      if (known) known.push(entry);
      else byAttribute.set(attribute, [entry]);
    }
    return byAttribute;
  }, [changeRows]);
  const attributes = useMemo(() => {
    const raw = specs?.["attributes"];
    if (typeof raw !== "string" || !raw) return [] as [string, string][];
    try {
      return Object.entries(JSON.parse(raw) as Record<string, string>).sort(([a], [b]) =>
        a.localeCompare(b),
      );
    } catch {
      return [];
    }
  }, [specs]);

  const fullDate = (seconds: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(seconds * 1000),
    );
  const number = (value: unknown, unit?: string) => {
    if (typeof value !== "number") return null;
    const text = new Intl.NumberFormat(locale).format(value);
    return unit ? `${text} ${unit}` : text;
  };
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);

  const specItems = (
    [
      [gt("vCPUs"), number(specs?.["vcpu"])],
      [gt("Memory"), number(specs?.["memory_gib"], "GiB")],
      [gt("GPUs"), number(specs?.["gpus"])],
      [gt("GPU model"), text(specs?.["gpu_model"])],
      [gt("GPU memory"), number(specs?.["gpu_memory_gib"], "GiB")],
      [gt("Architecture"), text(specs?.["architecture"])],
      [gt("Processor"), text(specs?.["processor"])],
      [gt("Clock speed"), number(specs?.["clock_speed_ghz"], "GHz")],
      [gt("Network"), text(specs?.["network_performance"])],
      [gt("Storage"), text(specs?.["storage"])],
      [gt("Category"), text(specs?.["category"])],
      [
        gt("Generation"),
        specs ? (specs["current_generation"] ? gt("Current") : gt("Previous")) : null,
      ],
    ] as const
  ).filter((item): item is readonly [string, string] => item[1] !== null);

  const firstPriced = useMemo(() => {
    let first: number | null = null;
    for (const r of byRegionRows) {
      if (String(r["region"]) !== region) continue;
      const from = Number(r["validFrom"]);
      if (first === null || from < first) first = from;
    }
    return first;
  }, [byRegionRows, region]);
  const firstListed =
    typeof specs?.["first_listed"] === "string" ? parseWarehouseTime(specs["first_listed"]) : null;
  const freshness = useRows(freshnessQuery)[0]?.["asOf"];
  const asOf = typeof freshness === "string" ? parseWarehouseTime(freshness) : null;
  const lifecycleItems = [
    firstListed !== null ? ([gt("First listed"), fullDate(firstListed)] as const) : null,
    retiredAt !== null ? ([gt("Last listed"), fullDate(retiredAt)] as const) : null,
    firstPriced !== null ? ([gt("First priced here"), fullDate(firstPriced)] as const) : null,
    regions.length > 0 ? ([gt("Regions offering it"), String(regions.length)] as const) : null,
    asOf !== null ? ([gt("Price list as of"), fullDate(asOf)] as const) : null,
  ].filter((item): item is readonly [string, string] => item !== null);

  if (regionsQuery.error || offersQuery.error) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-on-surface-muted">
        {gt("Instance prices aren't available right now.")}
        <button
          type="button"
          onClick={() => {
            regionsQuery.retry();
            offersQuery.retry();
          }}
          className="inline-flex items-center gap-1 text-accent hover:text-accent-hover"
        >
          <RefreshIcon size={12} />
          {gt("Try again")}
        </button>
      </p>
    );
  }
  if (regionsQuery.loading && !regionsQuery.result) {
    return <p className="text-sm text-on-surface-muted">{gt("Loading instance prices…")}</p>;
  }
  if (!regionsQuery.loading && regions.length === 0) {
    return (
      <p className="text-sm text-on-surface-muted">
        {gt("{name} has no published on-demand prices.", { name: instanceType })}
      </p>
    );
  }

  const termLabel = (key: string) => key.split("|").filter(Boolean).join(", ");

  // What the resource runs, where the price list does not sell it: the panel has
  // moved to the nearest thing it can price and must not pass that off as this
  // resource's own price.
  const fallbacks: string[] = [];
  if (capability.region && capability.region === regionChoice && region !== capability.region) {
    fallbacks.push(
      gt("{name} isn't listed in {wanted}, so these prices are for {shown}.", {
        name: instanceType,
        wanted: capability.region,
        shown: regionName,
      }),
    );
  }
  for (const [key, wanted] of Object.entries(capability.selection ?? {})) {
    const shown = selection[key];
    if (picked[key] !== wanted || shown === undefined || shown === wanted) continue;
    fallbacks.push(
      gt("{name} isn't listed with {field} {wanted} here, so these prices are for {shown}.", {
        name: instanceType,
        field: dimensionLabel(gt, tr, key),
        wanted: tr(wanted),
        shown: tr(shown),
      }),
    );
  }

  return (
    <div className="space-y-5">
      {fallbacks.length > 0 && (
        <ul className="space-y-1 text-xs text-on-surface-muted">
          {fallbacks.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
        {onDemand !== null && (
          <PriceCard label={gt("On demand")} price={inPeriod(onDemand)} note={periodNote} />
        )}
        {spot !== null && (
          <PriceCard
            label={gt("Spot")}
            price={inPeriod(spot)}
            note={periodNote}
            saving={savingOn(spot)}
          />
        )}
        {termLeases.map((offer) => (
          <PriceCard
            key={offer.lease}
            label={gt("{lease} commitment", { lease: offer.lease })}
            price={inPeriod(offer.effective)}
            note={periodNote}
            saving={savingOn(offer.effective)}
          />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
        {instanceTypes.length > 1 && (
          <Picker
            label={gt("Instance type")}
            value={instanceType}
            options={instanceTypes.map((t) => ({ value: t, label: t }))}
            onChange={setInstanceType}
          />
        )}
        {regions.length > 1 && (
          <Picker
            label={gt("Region")}
            value={region}
            options={regions.map((code) => {
              const name = names.get(code);
              return { value: code, label: name && name !== code ? `${name} (${code})` : code };
            })}
            onChange={setRegionChoice}
          />
        )}
        {choices.map((choice) => (
          <Picker
            key={choice.key}
            label={dimensionLabel(gt, tr, choice.key)}
            value={choice.value}
            options={choice.values.map((v) => ({ value: v, label: tr(v) }))}
            onChange={(value) => pick(choice.key, value)}
          />
        ))}
        {termKeys.length > 1 && (
          <Picker
            label={gt("Commitment")}
            value={term}
            options={termKeys.map((key) => ({ value: key, label: termLabel(key) }))}
            onChange={setTermChoice}
          />
        )}
        <Picker
          label={gt("Show prices")}
          value={period}
          options={[
            { value: "hourly", label: gt("Hourly") },
            { value: "monthly", label: gt("Monthly") },
          ]}
          onChange={(value) => setPeriod(value === "monthly" ? "monthly" : "hourly")}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {specItems.length > 0 && (
            <Section title={gt("Specs")} state={specsQuery}>
              <SpecList items={specItems} />
            </Section>
          )}
          {lifecycleItems.length > 0 && (
            <Section title={gt("Lifecycle")}>
              <SpecList items={lifecycleItems} />
            </Section>
          )}
          {committed.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-on-surface-secondary hover:text-on-surface">
                {gt("Every committed term")}
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-on-surface-muted">
                      <th className="p-1 font-medium">{gt("Term")}</th>
                      <th className="p-1 text-right font-medium">{gt("Upfront")}</th>
                      <th className="p-1 text-right font-medium">{gt("Hourly")}</th>
                      <th className="p-1 text-right font-medium">{gt("Effective")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...committed]
                      .sort(
                        (a, b) =>
                          instanceLeaseMonths(a.lease) - instanceLeaseMonths(b.lease) ||
                          a.effective - b.effective,
                      )
                      .map((offer) => (
                        <tr
                          key={`${offer.lease}|${instanceTermKey(offer)}|${offer.effective}`}
                          className="border-t border-border"
                        >
                          <td className="p-1">
                            {offer.lease} {termLabel(instanceTermKey(offer))}
                          </td>
                          <td className="p-1 text-right tabular-nums">{money(offer.upfront)}</td>
                          <td className="p-1 text-right tabular-nums">{money(offer.hourly)}</td>
                          <td className="p-1 text-right tabular-nums">{money(offer.effective)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {familyRows.length > 1 && (
            <Section
              title={
                oneRegion
                  ? gt("Family sizes")
                  : gt("Family sizes in {region}", { region: regionName })
              }
              state={familyQuery}
            >
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-on-surface-muted">
                      <th className="p-1 font-medium">{gt("Size")}</th>
                      <th className="p-1 text-right font-medium">{gt("vCPUs")}</th>
                      <th className="p-1 text-right font-medium">{gt("Memory")}</th>
                      <th className="p-1 text-right font-medium">{periodNote}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {familyRows.map((r) => {
                      const name = String(r["instanceType"]);
                      return (
                        <tr
                          key={name}
                          className={`border-t border-border ${name === instanceType ? "bg-surface-overlay font-semibold" : ""}`}
                        >
                          <td className="p-1">
                            {name === instanceType ? (
                              name
                            ) : (
                              <a
                                href={instancePricingPageUrl(platform, name, region)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-accent hover:text-accent-hover"
                              >
                                {name}
                              </a>
                            )}
                          </td>
                          <td className="p-1 text-right tabular-nums">{number(r["vcpu"])}</td>
                          <td className="p-1 text-right tabular-nums">{number(r["memoryGib"])}</td>
                          <td className="p-1 text-right tabular-nums">
                            {inPeriod(Number(r["price"]))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Section
            title={
              oneRegion
                ? gt("Price history")
                : gt("Price history in {region}", { region: regionName })
            }
            state={historyQuery}
          >
            <StepSeriesChart
              series={history}
              end={historyEnd + DAY}
              format={money}
              label={
                oneRegion
                  ? gt("Price history of {name}", { name: instanceType })
                  : gt("Price history of {name} in {region}", {
                      name: instanceType,
                      region: regionName,
                    })
              }
            />
          </Section>
          {regionBars.length > 1 && (
            <Section title={gt("On-demand price by region")} state={byRegionQuery}>
              <BarList
                bars={regionBars}
                format={inPeriod}
                label={gt("On-demand price of {name} by region", { name: instanceType })}
                onSelect={setRegionChoice}
              />
            </Section>
          )}
          {spotBars.length > 1 && (
            <Section title={gt("Spot price by region")} state={spotByRegionQuery}>
              <BarList
                bars={spotBars}
                format={inPeriod}
                label={gt("Spot price of {name} by region", { name: instanceType })}
                onSelect={setRegionChoice}
              />
            </Section>
          )}
          {compareBars.length > 1 && (
            <Section
              title={
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {oneRegion
                    ? gt("On-demand price, compared by")
                    : gt("On-demand price in {region}, compared by", { region: regionName })}
                  <select
                    aria-label={gt("Compare by")}
                    value={compareKey}
                    onChange={(e) => setCompareChoice(e.target.value)}
                    className="rounded border border-border-strong bg-surface-overlay px-2 py-0.5 text-xs font-normal text-on-surface"
                  >
                    {choices.map((c) => (
                      <option key={c.key} value={c.key}>
                        {dimensionLabel(gt, tr, c.key)}
                      </option>
                    ))}
                  </select>
                </span>
              }
            >
              <BarList
                bars={compareBars}
                format={inPeriod}
                label={gt("On-demand price of {name} by {field}", {
                  name: instanceType,
                  field: dimensionLabel(gt, tr, compareKey),
                })}
                onSelect={(value) => pick(compareKey, value)}
              />
            </Section>
          )}
          {regions.length > 1 && availability.length > 0 && (
            <Section title={gt("Regions offering it over time")} state={byRegionQuery}>
              <StepSeriesChart
                series={[{ id: "regions", label: gt("Regions"), points: availability }]}
                end={historyEnd + DAY}
                format={(v) => new Intl.NumberFormat(locale).format(Math.round(v))}
                label={gt("Number of regions offering {name} on demand over time", {
                  name: instanceType,
                })}
                fromZero
                height={180}
              />
            </Section>
          )}
        </div>
      </div>

      {attributes.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-on-surface-secondary hover:text-on-surface">
            {gt("Every attribute the provider publishes")}
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {attributes.map(([key, value]) => {
                  const history = changes.get(key) ?? [];
                  return (
                    <tr key={key} className="border-t border-border align-top">
                      <td className="w-1/3 p-1 text-on-surface-muted">{tr(camelToTitle(key))}</td>
                      <td className="p-1">
                        <span className="break-words">{value}</span>
                        {history.length > 1 && (
                          <details className="mt-0.5">
                            <summary className="cursor-pointer text-on-surface-faint">
                              {gt("Changed {count} times", { count: history.length - 1 })}
                            </summary>
                            <ul className="mt-1 space-y-0.5 text-on-surface-muted">
                              {history.map((h) => (
                                <li key={`${h.at}|${h.value ?? ""}`}>
                                  {fullDate(h.at)}: {h.value ?? gt("no value")}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <a
        href={instancePricingPageUrl(platform, instanceType, region)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover"
      >
        {gt("Open this instance's full page")}
        <ExternalLinkIcon size={12} />
      </a>
    </div>
  );
}

/** A warehouse `YYYY-MM-DD hh:mm:ss`, which is UTC, as Unix seconds; null if it does not parse. */
function parseWarehouseTime(value: string): number | null {
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * The instance page of instances.infrawrench.com, folded into a resource's
 * overview: prices, price history, regions, family sizes and every published
 * attribute of what the resource runs. Collapsed until asked for, and nothing
 * reaches the warehouse before then, so a plain page view costs no queries.
 * Whether it opens is remembered per viewer.
 */
export function InstancePricingPanel({
  capability,
  query,
}: {
  capability: InstancePricingCapability;
  query: InstancePricingQuery;
}) {
  const gt = useGT();
  const bodyId = useId();
  const [open, setOpen] = useState(readOpen);
  // The body stays mounted once opened, so closing it keeps the selection.
  const [opened, setOpened] = useState(open);
  const summary = [capability.instanceTypes.join(", "), capability.region]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="rounded-lg border border-border">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            setOpened(true);
            writeOpen(!open);
          }}
          className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left hover:bg-surface-overlay"
        >
          <ChevronIcon direction={open ? "down" : "right"} size={14} />
          <span className="text-sm font-medium text-on-surface">
            {gt("Instance pricing and specs")}
          </span>
          <span className="min-w-0 truncate text-xs text-on-surface-muted">{summary}</span>
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="border-t border-border p-4">
        {opened && <PanelBody capability={capability} query={query} />}
      </div>
    </section>
  );
}
