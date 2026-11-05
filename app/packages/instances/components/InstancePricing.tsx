"use client";

import { msg, useGT, useLocale } from "gt-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attributeTimelines,
  closestOffered,
  fieldOptions,
  offeredVariants,
  withField,
} from "@/lib/selection";
import { isGpuType, variantLabel, variantValueLabel } from "@/lib/attributes";
import {
  DURATIONS,
  USD,
  commitmentLabel,
  effectiveHourly,
  formatDate,
  formatPrice,
  isDuration,
  termLabel,
  termOptionKey,
  type Duration,
  type Money,
} from "@/lib/format";
import { useDataString } from "@/lib/i18n/data-string";
import { findRegion, spotSystem, type InstanceModel, type RegionData } from "@/lib/model";
import { CLOUDS, cloudOf } from "@/lib/platforms";
import { defaultTermOption, headlineTerms, priceHistory, seriesLabel } from "@/lib/series";
import type { StepSeries } from "./charts/StepChart";
import { SearchSelect } from "./SearchSelect";

/** The location types, in picker order, with their group labels (`msg()` sources). */
const REGION_GROUPS: Readonly<Record<string, string>> = {
  "AWS Region": msg("AWS Regions"),
  "AWS Local Zone": msg("Local Zones"),
  "AWS Wavelength Zone": msg("Wavelength Zones"),
  "Azure Region": msg("Azure regions"),
  "Google Cloud Region": msg("Google Cloud regions"),
  "Alibaba Cloud Region": msg("Alibaba Cloud regions"),
};
const GROUP_ORDER = Object.keys(REGION_GROUPS);
const OTHER_GROUP = msg("Other locations");

/** On demand, spot, and the committed terms by slot (shortest lease first). */
const SERIES_COLORS = {
  od: "var(--series-1)",
  spot: "var(--series-4)",
  terms: ["var(--series-2)", "var(--series-3)", "var(--series-5)"],
} as const;

/** Remembers the visitor's currency in this browser; a convenience, so failures are ignored. */
const CURRENCY_KEY = "instances-currency";
function storedCurrency(): string | null {
  try {
    return window.localStorage.getItem(CURRENCY_KEY);
  } catch {
    return null;
  }
}
function storeCurrency(code: string) {
  try {
    window.localStorage.setItem(CURRENCY_KEY, code);
  } catch {
    // Private windows and blocked storage: the URL still carries it.
  }
}

/**
 * What the instance page and its compact embed share: the selection (region,
 * variant, term, duration, currency), kept in the URL; the region's price data,
 * fetched when it changes; and the prices and history that follow from them.
 */
export function useInstancePricing(
  m: InstanceModel,
  {
    rememberCurrency = true,
  }: {
    /** Off in the embeds, which store nothing; `?currency=` still works there. */
    rememberCurrency?: boolean;
  } = {},
) {
  const gt = useGT();
  const tr = useDataString();
  const locale = useLocale();
  const defaultTerm = useMemo(() => defaultTermOption(m), [m]);

  const [region, setRegionState] = useState(m.defaultRegion);
  const [variant, setVariant] = useState(m.defaultVariant);
  const [termOption, setTermOption] = useState(defaultTerm);
  const [duration, setDuration] = useState<Duration>("hourly");
  const [currency, setCurrency] = useState("USD");
  const [regionData, setRegionData] = useState<Record<number, RegionData>>({
    [m.defaultRegion]: m.regionData,
  });
  const [failed, setFailed] = useState<number | null>(null);
  const [suffix, setSuffix] = useState("");
  const lastData = useRef(m.regionData);
  const [hydrated, setHydrated] = useState(false);

  const setRegion = useCallback(
    (r: number) => {
      setRegionState(r);
      setVariant((v) => closestOffered(m, v, r));
    },
    [m],
  );

  // The page is cached without its query string, so the selection in a shared
  // link is applied once it reaches the browser.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    let r = m.defaultRegion;
    const rid = q.get("region");
    if (rid) {
      const i = findRegion(m.regions, rid);
      if (i >= 0) r = i;
    }
    let v = closestOffered(m, m.defaultVariant, r);
    for (const k of m.shownKeys) {
      const value = q.get(m.variantKeys[k]!);
      if (value !== null && m.variants.some((x) => x[k] === value))
        v = withField(m, v, k, value, r);
    }
    const d = q.get("duration");
    const term = q.get("reserved");
    const cur = q.get("currency") ?? (rememberCurrency ? storedCurrency() : null);
    if (cur && m.fx && Object.hasOwn(m.fx.perUsd, cur)) setCurrency(cur);
    setRegionState(r);
    setVariant(v);
    if (isDuration(d)) setDuration(d);
    if (term && m.terms.some((t) => termOptionKey(t) === term)) setTermOption(term);
    setHydrated(true);
  }, [m, rememberCurrency]);

  // Keep the URL (and the family links, which carry the selection along) in step.
  useEffect(() => {
    if (!hydrated) return;
    const q = new URLSearchParams();
    if (region !== m.defaultRegion) q.set("region", m.regions[region]!.id);
    for (const k of m.shownKeys) {
      const value = m.variants[variant]![k]!;
      if (value !== m.variants[m.defaultVariant]![k]) q.set(m.variantKeys[k]!, value);
    }
    if (duration !== "hourly") q.set("duration", duration);
    if (termOption !== defaultTerm) q.set("reserved", termOption);
    if (currency !== "USD") q.set("currency", currency);
    if (rememberCurrency) storeCurrency(currency);
    const search = q.toString() ? `?${q}` : "";
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
    setSuffix(search);
  }, [m, hydrated, region, variant, duration, termOption, defaultTerm, currency, rememberCurrency]);

  useEffect(() => {
    if (regionData[region]) return;
    let cancelled = false;
    setFailed(null);
    fetch(
      `/api/prices/${m.platform}/${encodeURIComponent(m.name)}/${encodeURIComponent(m.regions[region]!.id)}`,
    )
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<RegionData>;
      })
      .then((data) => {
        if (!cancelled) setRegionData((prev) => ({ ...prev, [region]: data }));
      })
      .catch(() => {
        if (!cancelled) setFailed(region);
      });
    return () => {
      cancelled = true;
    };
  }, [m, region, regionData]);

  const data = regionData[region];
  if (data) lastData.current = data;
  const shown = data ?? lastData.current;
  const loading = !data;

  const offered = useMemo(() => offeredVariants(m, region), [m, region]);
  const onDemand = offered.get(variant) ?? null;
  const noneOffered = m.current.every((pairs) => pairs.length === 0);
  // The spot system priced like the selected variant, or -1 where spot does not apply.
  const system = useMemo(() => spotSystem(m, variant), [m, variant]);
  const spotIn = useCallback(
    (r: number) => m.spot?.current[r]?.find(([s]) => s === system)?.[1],
    [m.spot, system],
  );
  const spotEnd = Math.max(m.asOf, m.spot?.asOf ?? 0);

  /** The committed terms shown beside on demand, for the selected class and purchase option. */
  const headline = useMemo(() => headlineTerms(m, termOption), [m, termOption]);

  const reservedRows = useCallback(
    (term: number) => (term < 0 || !data ? undefined : data.reserved[`${variant}:${term}`]),
    [data, variant],
  );

  const latestReserved = (term: number): number | null | undefined => {
    const rows = reservedRows(term);
    if (rows === undefined) return data ? null : undefined;
    const last = rows.at(-1)!;
    return last[1] === null ? null : effectiveHourly(m.terms[term]!, last[1], last[2] ?? 0);
  };

  const money: Money = useMemo(() => {
    const rate = m.fx?.perUsd[currency];
    return rate ? { code: currency, rate } : USD;
  }, [m.fx, currency]);
  const notAvailable = gt("N/A");
  const price = useCallback(
    (v: number | null | undefined, per: Duration = duration) =>
      formatPrice(v, per, money, locale) ?? notAvailable,
    [duration, money, locale, notAvailable],
  );
  const fmt = useCallback((v: number) => price(v), [price]);

  const history: StepSeries[] = useMemo(
    () =>
      priceHistory(m, shown, variant, termOption).map((s) => ({
        ...s,
        label: seriesLabel(m, s, tr),
        color:
          s.slot !== undefined
            ? SERIES_COLORS.terms[s.slot]!
            : s.id === "spot"
              ? SERIES_COLORS.spot
              : SERIES_COLORS.od,
      })),
    [m, shown, variant, termOption, tr],
  );

  const timelines = useMemo(() => attributeTimelines(m.attributes, region), [m.attributes, region]);
  const attrs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, steps] of timelines) {
      const value = steps.at(-1)?.value;
      if (value !== null && value !== undefined) out[key] = value;
    }
    return out;
  }, [timelines]);

  const termOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of m.terms)
      if (!seen.has(termOptionKey(t))) seen.set(termOptionKey(t), termLabel(t, tr));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], locale));
  }, [m.terms, tr, locale]);

  const regionGroups = useMemo(() => {
    const groups = new Map<string, number[]>();
    m.regions.forEach((r, i) => {
      const g = r.type && GROUP_ORDER.includes(r.type) ? r.type : "";
      groups.set(g, [...(groups.get(g) ?? []), i]);
    });
    for (const list of groups.values())
      list.sort((a, b) => m.regions[a]!.name.localeCompare(m.regions[b]!.name));
    return [...groups.entries()].sort(
      (a, b) => (GROUP_ORDER.indexOf(a[0]) + 1 || 99) - (GROUP_ORDER.indexOf(b[0]) + 1 || 99),
    );
  }, [m.regions]);

  /** Every currency the ECB quotes, named in the reader's language ("EUR", "Euro"). */
  const currencyOptions = useMemo(() => {
    if (!m.fx) return [];
    const names = new Intl.DisplayNames([locale], { type: "currency" });
    return Object.keys(m.fx.perUsd)
      .sort()
      .map((code) => ({ value: code, label: code, detail: names.of(code) ?? "" }));
  }, [m.fx, locale]);

  const regionName = m.regions[region]!.name;
  // RunPod prices every pod the same in every data center: one location, `global`.
  const oneRegion = m.regions.length <= 1;
  const provider = CLOUDS[cloudOf(m.platform)].label;
  const perGpu = isGpuType(attrs);

  return {
    m,
    region,
    setRegion,
    variant,
    setVariant,
    termOption,
    setTermOption,
    duration,
    setDuration,
    currency,
    setCurrency,
    data,
    shown,
    loading,
    failed,
    suffix,
    offered,
    onDemand,
    noneOffered,
    system,
    spotIn,
    spotEnd,
    headline,
    latestReserved,
    money,
    notAvailable,
    price,
    fmt,
    history,
    timelines,
    attrs,
    termOptions,
    regionGroups,
    currencyOptions,
    regionName,
    oneRegion,
    provider,
    perGpu,
  };
}

export type InstancePricing = ReturnType<typeof useInstancePricing>;

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-ink-2">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

/** On demand, the headline committed terms and spot, for the current selection. */
export function PriceRow({ pricing }: { pricing: InstancePricing }) {
  const gt = useGT();
  const tr = useDataString();
  const { m, noneOffered, notAvailable, price, onDemand, headline, latestReserved, system } =
    pricing;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2" aria-live="polite" aria-atomic="true">
      <Price label={gt("On demand")} value={noneOffered ? notAvailable : price(onDemand)} />
      {headline.map((term) => {
        const v = latestReserved(term);
        return (
          <Price
            key={term}
            label={commitmentLabel(m.terms[term]!, tr)}
            value={v === undefined ? "…" : price(v)}
          />
        );
      })}
      {system >= 0 && (
        <Price label={gt("Spot")} value={price(pricing.spotIn(pricing.region) ?? null)} />
      )}
    </div>
  );
}

/** What the prices above mean. `spot` is off where the space is tight. */
export function PricingNotes({
  pricing,
  spot = true,
}: {
  pricing: InstancePricing;
  spot?: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { m, money, perGpu, system } = pricing;
  return (
    <>
      {perGpu && (
        <p className="mt-1 text-xs text-ink-3">
          {gt("Prices are per GPU; a pod can have several.")}
        </p>
      )}
      <p className="mt-1 text-xs text-ink-3">
        {gt("Reserved prices include the upfront payment, spread over the term.")}
        {money.code !== "USD" &&
          m.fx &&
          `${/^(ja|zh)\b/.test(locale) ? "" : " "}${gt(
            "Converted from USD at the European Central Bank reference rate of {date}.",
            {
              date: formatDate(Date.parse(m.fx.date) / 1000, locale),
            },
          )}`}
      </p>
      {spot && system >= 0 && (
        <p className="mt-1 text-xs text-ink-3">
          {gt(
            "Spot is the lowest price across the region's availability zones, and changes often.",
          )}
        </p>
      )}
    </>
  );
}

/**
 * The pickers, as children of the caller's grid. `variants` adds one per
 * variant field (operating system, tenancy and so on); the embed leaves those to the full page.
 */
export function PricingPickers({
  pricing,
  variants = true,
  regionClassName = "col-span-2",
}: {
  pricing: InstancePricing;
  variants?: boolean;
  regionClassName?: string;
}) {
  const gt = useGT();
  const tr = useDataString();
  const {
    m,
    region,
    setRegion,
    variant,
    setVariant,
    noneOffered,
    oneRegion,
    regionGroups,
    termOptions,
    termOption,
    setTermOption,
    currency,
    setCurrency,
    currencyOptions,
    duration,
    setDuration,
  } = pricing;
  return (
    <>
      {!oneRegion && (
        <SearchSelect
          className={regionClassName}
          label={gt("Region")}
          value={String(region)}
          onChange={(v) => setRegion(Number(v))}
          searchable
          options={regionGroups.flatMap(([group, list]) =>
            list.map((i) => {
              const r = m.regions[i]!;
              const available = noneOffered || (m.current[i]?.length ?? 0) > 0;
              return {
                value: String(i),
                label: available ? r.name : `${r.name} - ${gt("not offered")}`,
                detail: r.code ?? "",
                group: tr(REGION_GROUPS[group] ?? OTHER_GROUP),
                disabled: !available && i !== region,
              };
            }),
          )}
        />
      )}
      {variants &&
        m.shownKeys.map((k) => {
          const options = fieldOptions(m, k, region);
          const value = m.variants[variant]![k]!;
          if (!options.includes(value)) options.push(value);
          return (
            <SearchSelect
              key={k}
              label={tr(variantLabel(m.variantKeys[k]!))}
              value={value}
              onChange={(v) => setVariant(withField(m, variant, k, v, region))}
              options={options.map((o) => ({ value: o, label: tr(variantValueLabel(o)) }))}
            />
          );
        })}
      {termOptions.length > 0 && (
        <SearchSelect
          label={gt("Reserved term")}
          value={termOption}
          onChange={setTermOption}
          options={termOptions.map(([key, label]) => ({ value: key, label }))}
        />
      )}
      {m.fx && (
        <SearchSelect
          label={gt("Currency")}
          value={currency}
          onChange={setCurrency}
          searchable
          options={currencyOptions}
        />
      )}
      <SearchSelect
        label={gt("Cost per")}
        value={duration}
        onChange={(v) => setDuration(v as Duration)}
        options={Object.entries(DURATIONS).map(([key, d]) => ({
          value: key,
          label: tr(d.label),
        }))}
      />
    </>
  );
}
