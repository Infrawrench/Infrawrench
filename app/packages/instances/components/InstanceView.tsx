"use client";

import Link from "next/link";
import { msg, useGT, useLocale } from "gt-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attributeLabel, groupAttributes, variantLabel, variantValueLabel } from "@/lib/attributes";
import {
  DURATIONS,
  USD,
  effectiveHourly,
  formatDate,
  formatPrice,
  isDuration,
  leaseLabel,
  termLabel,
  termOptionKey,
  type Duration,
  type Money,
} from "@/lib/format";
import { useDataString } from "@/lib/i18n/data-string";
import { localePath } from "@/lib/i18n/locales";
import { findRegion, spotSystem, type InstanceModel, type RegionData } from "@/lib/model";
import {
  attributeTimelines,
  closestOffered,
  fieldOptions,
  offeredVariants,
  variantsAlong,
  withField,
} from "@/lib/selection";
import { defaultTermOption, priceHistory } from "@/lib/series";
import { Breadcrumbs } from "./Breadcrumbs";
import { BarChart } from "./charts/BarChart";
import { StepChart, type StepSeries } from "./charts/StepChart";
import { HistoryBadge } from "./HistoryBadge";
import { SearchSelect } from "./SearchSelect";
import { CalendarClockIcon, ChartIcon, InfoIcon, ServerIcon } from "./icons";

/** AWS's location types, in picker order, with their group labels (`msg()` sources). */
const REGION_GROUPS: Readonly<Record<string, string>> = {
  "AWS Region": msg("AWS Regions"),
  "AWS Local Zone": msg("Local Zones"),
  "AWS Wavelength Zone": msg("Wavelength Zones"),
};
const GROUP_ORDER = Object.keys(REGION_GROUPS);
const OTHER_GROUP = msg("Other locations");

const SERIES_COLORS = {
  od: "var(--series-1)",
  "1yr": "var(--series-2)",
  "3yr": "var(--series-3)",
  spot: "var(--series-4)",
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

const linkClass = "text-accent hover:text-accent-hover";

export function InstanceView({
  model: m,
  description,
}: {
  model: InstanceModel;
  description: string;
}) {
  const gt = useGT();
  const tr = useDataString();
  const locale = useLocale();
  const defaultTerm = useMemo(() => defaultTermOption(m), [m]);

  const [region, setRegionState] = useState(m.defaultRegion);
  const [variant, setVariant] = useState(m.defaultVariant);
  const [termOption, setTermOption] = useState(defaultTerm);
  const [duration, setDuration] = useState<Duration>("hourly");
  const [currency, setCurrency] = useState("USD");
  const [compareKey, setCompareKey] = useState(m.shownKeys[0] ?? 0);
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
    const cur = q.get("currency") ?? storedCurrency();
    if (cur && m.fx && Object.hasOwn(m.fx.perUsd, cur)) setCurrency(cur);
    setRegionState(r);
    setVariant(v);
    if (isDuration(d)) setDuration(d);
    if (term && m.terms.some((t) => termOptionKey(t) === term)) setTermOption(term);
    setHydrated(true);
  }, [m]);

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
    storeCurrency(currency);
    const search = q.toString() ? `?${q}` : "";
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
    setSuffix(search);
  }, [m, hydrated, region, variant, duration, termOption, defaultTerm, currency]);

  useEffect(() => {
    if (regionData[region]) return;
    let cancelled = false;
    setFailed(null);
    fetch(
      `/api/aws/${m.platform}/${encodeURIComponent(m.name)}/${encodeURIComponent(m.regions[region]!.id)}`,
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

  /** The term with this lease and the selected class and purchase option. */
  const termFor = useCallback(
    (lease: string) =>
      m.terms.findIndex((t) => t.lease === lease && termOptionKey(t) === termOption),
    [m.terms, termOption],
  );

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
        label: tr(s.label),
        color: SERIES_COLORS[s.id],
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

  const regionBars = useMemo(
    () =>
      m.regions
        .flatMap((r, i) => {
          const hourly = offeredVariants(m, i).get(variant);
          return hourly === undefined
            ? []
            : [
                {
                  id: String(i),
                  label: r.name,
                  detail: r.code ?? "",
                  value: hourly,
                  selected: i === region,
                },
              ];
        })
        .sort((a, b) => a.value - b.value),
    [m, variant, region],
  );

  const spotBars = useMemo(
    () =>
      system < 0
        ? []
        : m.regions
            .flatMap((r, i) => {
              const hourly = spotIn(i);
              return hourly === undefined
                ? []
                : [
                    {
                      id: String(i),
                      label: r.name,
                      detail: r.code ?? "",
                      value: hourly,
                      selected: i === region,
                    },
                  ];
            })
            .sort((a, b) => a.value - b.value),
    [m.regions, system, spotIn, region],
  );

  const compareBars = useMemo(
    () =>
      variantsAlong(m, variant, compareKey, region)
        .map((v) => ({
          id: String(v),
          label: tr(variantValueLabel(m.variants[v]![compareKey]!)),
          value: offered.get(v)!,
          selected: v === variant,
        }))
        .sort((a, b) => a.value - b.value),
    [m, variant, compareKey, region, offered, tr],
  );

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
  const firstPriced = shown.onDemand[variant]?.[0]?.[0];

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1280px] px-4 py-4 sm:px-7">
      <Breadcrumbs
        items={[
          { label: "AWS", href: localePath(locale, "/aws") },
          { label: m.platformLabel, href: localePath(locale, `/aws/${m.platform}`) },
          { label: m.name },
        ]}
      />

      {m.deletedAt !== null && (
        <p className="mb-4 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm">
          {gt("AWS stopped listing {name} on {date}. The history below runs up to then.", {
            name: m.name,
            date: formatDate(m.deletedAt, locale),
          })}
        </p>
      )}

      <div className="gap-8 md:flex">
        <div className="md:w-sm md:shrink-0">
          <h1 className="mb-2 text-2xl font-bold">{m.name}</h1>
          <p className="mb-4 text-sm text-ink-2">{description}</p>

          <section aria-labelledby="pricing-heading">
            <h2 id="pricing-heading" className="sr-only">
              {gt("Pricing")}
            </h2>
            <div className="flex flex-wrap gap-x-5 gap-y-2" aria-live="polite" aria-atomic="true">
              <Price label={gt("On demand")} value={noneOffered ? notAvailable : price(onDemand)} />
              {termOptions.length > 0 &&
                (["1yr", "3yr"] as const).map((lease) => {
                  const v = latestReserved(termFor(lease));
                  return (
                    <Price
                      key={lease}
                      label={lease === "1yr" ? gt("1-year reserved") : gt("3-year reserved")}
                      value={v === undefined ? "…" : price(v)}
                    />
                  );
                })}
              {system >= 0 && <Price label={gt("Spot")} value={price(spotIn(region) ?? null)} />}
            </div>
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
            {system >= 0 && (
              <p className="mt-1 text-xs text-ink-3">
                {gt(
                  "Spot is the lowest price across the region's availability zones, and changes often.",
                )}
              </p>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <SearchSelect
                className="col-span-2"
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
              {m.shownKeys.map((k) => {
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
            </div>
          </section>

          <ReservedTable m={m} data={data} variant={variant} onDemand={onDemand} price={price} />

          <section className="mt-6 text-sm" aria-labelledby="lifecycle-heading">
            <h3 id="lifecycle-heading" className="flex items-center gap-2 font-semibold">
              <CalendarClockIcon /> {gt("Lifecycle")}
            </h3>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-ink-3">{gt("First listed")}</dt>
              <dd>{formatDate(m.createdAt, locale)}</dd>
              {m.deletedAt !== null && (
                <>
                  <dt className="text-ink-3">{gt("Last listed")}</dt>
                  <dd>{formatDate(m.deletedAt, locale)}</dd>
                </>
              )}
              {firstPriced !== undefined && (
                <>
                  <dt className="text-ink-3">{gt("First priced here")}</dt>
                  <dd>{formatDate(firstPriced, locale)}</dd>
                </>
              )}
              <dt className="text-ink-3">{gt("Price list as of")}</dt>
              <dd>{formatDate(m.asOf, locale)}</dd>
              {m.spot && (
                <>
                  <dt className="text-ink-3">{gt("Spot prices as of")}</dt>
                  <dd>{formatDate(m.spot.asOf, locale)}</dd>
                </>
              )}
            </dl>
          </section>

          <FamilySizes m={m} suffix={suffix} locale={locale} />
          <Related m={m} suffix={suffix} locale={locale} />
        </div>

        <div className="mt-6 min-w-0 flex-1 md:mt-0">
          <article>
            <h2 className="flex items-center gap-2 font-bold">
              <InfoIcon /> {gt("Instance details")}
            </h2>
            <p className="mt-1 text-xs text-ink-3">
              {gt(
                "In {region}. A clock marks a value that has changed; hover it for every value it has had.",
                { region: regionName },
              )}
            </p>
            {groupAttributes(attrs).map(({ section, keys }) => (
              <table
                key={section.slug}
                id={section.slug}
                className="mt-4 w-full border-collapse border border-line text-sm"
              >
                <thead>
                  <tr className="bg-surface-2">
                    <th className="p-1.5 text-left">
                      <a href={`#${section.slug}`} className={linkClass}>
                        {tr(section.name)}
                      </a>
                    </th>
                    <th className="border-l border-line p-1.5 text-left">{gt("Value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => {
                    const steps = timelines.get(key) ?? [];
                    return (
                      <tr key={key}>
                        <td className="w-1/2 border border-line px-3 py-1.5">
                          {tr(attributeLabel(key))}
                        </td>
                        <td className="w-1/2 border border-line px-3 py-1.5">
                          <span className="break-words">{attrs[key]}</span>
                          {steps.length > 1 && (
                            <HistoryBadge label={tr(attributeLabel(key))} steps={steps} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}
          </article>

          <ChartSection
            id="price-history"
            className="mt-8"
            title={gt("Price history in {region}", { region: regionName })}
            loading={loading}
            note={
              failed === region
                ? gt("Couldn't load this region's history. Showing the previous region.")
                : undefined
            }
          >
            <StepChart
              series={history}
              end={m.deletedAt ?? spotEnd}
              format={fmt}
              label={gt("Price history of {name} in {region}", {
                name: m.name,
                region: regionName,
              })}
            />
          </ChartSection>

          {regionBars.length > 1 && (
            <ChartSection id="by-region" title={gt("On-demand price by region")} className="mt-8">
              <BarChart
                bars={regionBars}
                format={fmt}
                label={gt("On-demand price of {name} by region", { name: m.name })}
                onSelect={(id) => setRegion(Number(id))}
              />
            </ChartSection>
          )}

          {spotBars.length > 1 && (
            <ChartSection id="spot-by-region" title={gt("Spot price by region")} className="mt-8">
              <BarChart
                bars={spotBars}
                format={fmt}
                label={gt("Spot price of {name} by region", { name: m.name })}
                onSelect={(id) => setRegion(Number(id))}
              />
            </ChartSection>
          )}

          {m.shownKeys.length > 0 && compareBars.length > 0 && (
            <ChartSection
              id="compare"
              className="mt-8"
              title={
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {gt("On-demand price in {region}", { region: regionName })}
                  <span className="flex items-center gap-1.5 text-xs font-normal text-ink-2">
                    {gt("Compare by")}
                    <SearchSelect
                      className="w-44"
                      label={gt("Compare by")}
                      hideLabel
                      value={String(compareKey)}
                      onChange={(v) => setCompareKey(Number(v))}
                      options={m.shownKeys.map((k) => ({
                        value: String(k),
                        label: tr(variantLabel(m.variantKeys[k]!)),
                      }))}
                    />
                  </span>
                </span>
              }
            >
              <BarChart
                bars={compareBars}
                format={fmt}
                label={gt("On-demand price of {name} in {region} by {field}", {
                  name: m.name,
                  region: regionName,
                  field: tr(variantLabel(m.variantKeys[compareKey]!)).toLocaleLowerCase(locale),
                })}
                onSelect={(id) => setVariant(Number(id))}
              />
            </ChartSection>
          )}

          {m.availability.length > 0 && (
            <ChartSection
              id="availability"
              title={gt("Regions offering it over time")}
              className="mt-8"
            >
              <StepChart
                series={[
                  {
                    id: "regions",
                    label: gt("Regions"),
                    color: "var(--series-1)",
                    points: m.availability,
                  },
                ]}
                end={m.deletedAt ?? m.asOf}
                format={(v) => Math.round(v).toLocaleString(locale)}
                label={gt("Number of regions offering {name} on demand over time", {
                  name: m.name,
                })}
                fromZero
                height={180}
              />
            </ChartSection>
          )}
        </div>
      </div>
    </main>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-bold tabular-nums">{value}</p>
      <p className="text-xs text-ink-3">{label}</p>
    </div>
  );
}

function ChartSection({
  id,
  title,
  loading,
  note,
  className,
  children,
}: {
  id: string;
  title: React.ReactNode;
  loading?: boolean;
  note?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={className} aria-busy={loading ?? false}>
      <h2 className="mb-2 flex items-center gap-2 font-bold">
        <ChartIcon />
        {title}
      </h2>
      {note && <p className="mb-2 text-xs text-ink-3">{note}</p>}
      <div className={`transition-opacity ${loading ? "opacity-50" : ""}`}>{children}</div>
    </section>
  );
}

function ReservedTable({
  m,
  data,
  variant,
  onDemand,
  price,
}: {
  m: InstanceModel;
  data: RegionData | undefined;
  variant: number;
  onDemand: number | null;
  price: (hourly: number | null | undefined, per?: Duration) => string;
}) {
  const gt = useGT();
  const tr = useDataString();
  const locale = useLocale();
  if (!data || m.terms.length === 0) return null;
  const rows = m.terms
    .map((t, i) => ({ t, last: data.reserved[`${variant}:${i}`]?.at(-1) }))
    .filter(
      (r): r is { t: (typeof m.terms)[number]; last: [number, number, number | null] } =>
        r.last?.[1] != null,
    )
    .sort(
      (a, b) =>
        a.t.lease.localeCompare(b.t.lease) ||
        a.t.offeringClass.localeCompare(b.t.offeringClass) ||
        a.t.purchaseOption.localeCompare(b.t.purchaseOption),
    );
  if (rows.length === 0) return null;
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer text-ink-2 hover:text-ink">
        {gt("Every reserved term")}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-surface-2 text-left">
              <th className="p-1">{gt("Term")}</th>
              <th className="p-1 text-right">{gt("Upfront")}</th>
              <th className="p-1 text-right">{gt("Hourly")}</th>
              <th className="p-1 text-right">{gt("Effective")}</th>
              <th className="p-1 text-right">{gt("Saving")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, last }) => {
              const eff = effectiveHourly(t, last[1], last[2] ?? 0);
              return (
                <tr
                  key={`${t.lease}${t.offeringClass}${t.purchaseOption}`}
                  className="border-t border-line"
                >
                  <td className="p-1">
                    {gt("{lease}, {option}", {
                      lease: leaseLabel(t.lease, tr),
                      option: termLabel(t, tr),
                    })}
                  </td>
                  <td className="p-1 text-right tabular-nums">{price(last[2] ?? 0, "hourly")}</td>
                  <td className="p-1 text-right tabular-nums">{price(last[1], "hourly")}</td>
                  <td className="p-1 text-right tabular-nums">{price(eff)}</td>
                  <td className="p-1 text-right tabular-nums">
                    {onDemand
                      ? new Intl.NumberFormat(locale, { style: "percent" }).format(
                          1 - eff / onDemand,
                        )
                      : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function FamilySizes({ m, suffix, locale }: { m: InstanceModel; suffix: string; locale: string }) {
  const gt = useGT();
  if (m.family.length < 2) return null;
  return (
    <section className="mt-6" aria-labelledby="family-heading">
      <h3 id="family-heading" className="flex items-center gap-2 font-semibold">
        <ServerIcon /> {gt("Family sizes")}
      </h3>
      <table className="mt-2 w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="pb-1 pl-2 text-left font-medium">{gt("Size")}</th>
            <th className="pb-1 pl-2 text-left font-medium">{gt("vCPUs")}</th>
            <th className="pb-1 pl-2 text-left font-medium">{gt("Memory")}</th>
          </tr>
        </thead>
        <tbody>
          {m.family.map((f) => {
            const self = f.name === m.name;
            return (
              <tr key={f.name} className={self ? "bg-ink text-surface" : "odd:bg-surface-2"}>
                <td className="border border-line p-1 pl-2">
                  {self ? (
                    f.name
                  ) : (
                    <Link
                      className={linkClass}
                      href={`${localePath(locale, `/aws/${m.platform}/${f.name}`)}${suffix}`}
                    >
                      {f.name}
                    </Link>
                  )}
                </td>
                <td className="border border-line p-1 pl-2 tabular-nums">{f.vcpu ?? ""}</td>
                <td className="border border-line p-1 pl-2 tabular-nums">{f.memory ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Related({ m, suffix, locale }: { m: InstanceModel; suffix: string; locale: string }) {
  const gt = useGT();
  if (m.related.length === 0) return null;
  return (
    <section className="mt-6" aria-labelledby="related-heading">
      <h3 id="related-heading" className="flex items-center gap-2 font-semibold">
        <ServerIcon /> {gt("Instance variants")}
      </h3>
      <ul className="mt-2 flex flex-wrap gap-1.5 text-sm">
        {m.related.map((r) => (
          <li key={r.family}>
            <Link
              className="inline-block rounded border border-line px-2 py-0.5 text-accent hover:border-accent hover:text-accent-hover"
              href={`${localePath(locale, `/aws/${m.platform}/${r.name}`)}${suffix}`}
              title={r.name}
            >
              {r.family}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
