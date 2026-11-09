"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { useCallback, useMemo, useState } from "react";
import { attributeLabel, groupAttributes, variantLabel, variantValueLabel } from "@/lib/attributes";
import {
  commitmentLabel,
  effectiveHourly,
  formatDate,
  leaseLabel,
  leaseMonths,
  termLabel,
  type Duration,
} from "@/lib/format";
import { useDataString } from "@/lib/i18n/data-string";
import { localePath } from "@/lib/i18n/locales";
import { type InstanceModel, type RegionData } from "@/lib/model";
import { offeredVariants, variantsAlong } from "@/lib/selection";
import { cloudOf, instancePath, platformPath } from "@/lib/platforms";
import { Breadcrumbs } from "./Breadcrumbs";
import { BarChart } from "./charts/BarChart";
import { StepChart, type StepSeries } from "./charts/StepChart";
import { HistoryBadge } from "./HistoryBadge";
import { PriceRow, PricingNotes, PricingPickers, useInstancePricing } from "./InstancePricing";
import { SearchSelect } from "./SearchSelect";
import { CalendarClockIcon, ChartIcon, InfoIcon, ServerIcon } from "./icons";

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
  const pricing = useInstancePricing(m);
  const {
    region,
    setRegion,
    variant,
    setVariant,
    data,
    shown,
    loading,
    failed,
    suffix,
    offered,
    onDemand,
    system,
    spotIn,
    spotEnd,
    price,
    fmt,
    history,
    timelines,
    attrs,
    regionName,
    oneRegion,
    provider,
  } = pricing;
  const [compareKey, setCompareKey] = useState(m.shownKeys[0] ?? 0);

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

  const firstPriced = shown.onDemand[variant]?.[0]?.[0];
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1280px] px-4 py-4 sm:px-7">
      <Breadcrumbs
        items={[
          { label: provider, href: localePath(locale, `/${cloudOf(m.platform)}`) },
          { label: m.platformLabel, href: localePath(locale, platformPath(m.platform)) },
          { label: m.name },
        ]}
        ask={m.name}
      />

      {m.deletedAt !== null && (
        <p className="mb-4 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm">
          {gt("{provider} stopped listing {name} on {date}. The history below runs up to then.", {
            provider,
            name: m.name,
            date: formatDate(m.deletedAt, locale),
          })}
        </p>
      )}

      <div className="gap-8 md:flex">
        <div className="md:w-sm md:shrink-0">
          <h1 className="mb-2 text-3xl font-semibold tracking-[-0.03em]">{m.name}</h1>
          <p className="mb-4 text-sm text-ink-2">{description}</p>

          <section aria-labelledby="pricing-heading">
            <h2 id="pricing-heading" className="sr-only">
              {gt("Pricing")}
            </h2>
            <PriceRow pricing={pricing} />
            <PricingNotes pricing={pricing} />

            <div className="mt-4 grid grid-cols-2 gap-2">
              <PricingPickers pricing={pricing} />
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
              {oneRegion
                ? gt("A clock marks a value that has changed; hover it for every value it has had.")
                : gt(
                    "In {region}. A clock marks a value that has changed; hover it for every value it has had.",
                    { region: regionName },
                  )}
            </p>
            {groupAttributes(attrs).map(({ section, keys }) => (
              <table
                key={section.slug}
                id={section.slug}
                className="mt-4 w-full border-collapse border border-line bg-surface text-sm"
              >
                <thead>
                  <tr className="bg-surface-2">
                    <th className="p-1.5 text-start">
                      <a href={`#${section.slug}`} className={linkClass}>
                        {tr(section.name)}
                      </a>
                    </th>
                    <th className="border-s border-line p-1.5 text-start">{gt("Value")}</th>
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
                          <bdi className="break-words">{attrs[key]}</bdi>
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
            title={
              oneRegion
                ? gt("Price history")
                : gt("Price history in {region}", { region: regionName })
            }
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
              label={
                oneRegion
                  ? gt("Price history of {name}", { name: m.name })
                  : gt("Price history of {name} in {region}", {
                      name: m.name,
                      region: regionName,
                    })
              }
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
                  {oneRegion
                    ? gt("On-demand price")
                    : gt("On-demand price in {region}", { region: regionName })}
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
                label={
                  oneRegion
                    ? gt("On-demand price of {name} by {field}", {
                        name: m.name,
                        field: tr(variantLabel(m.variantKeys[compareKey]!)).toLocaleLowerCase(
                          locale,
                        ),
                      })
                    : gt("On-demand price of {name} in {region} by {field}", {
                        name: m.name,
                        region: regionName,
                        field: tr(variantLabel(m.variantKeys[compareKey]!)).toLocaleLowerCase(
                          locale,
                        ),
                      })
                }
                onSelect={(id) => setVariant(Number(id))}
              />
            </ChartSection>
          )}

          {!oneRegion && m.availability.length > 0 && (
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
        (leaseMonths(a.t.lease) ?? 0) - (leaseMonths(b.t.lease) ?? 0) ||
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
        <table className="w-full border-collapse bg-surface text-xs">
          <thead>
            <tr className="bg-surface-2 text-start">
              <th className="p-1">{gt("Term")}</th>
              <th className="p-1 text-end">{gt("Upfront")}</th>
              <th className="p-1 text-end">{gt("Hourly")}</th>
              <th className="p-1 text-end">{gt("Effective")}</th>
              <th className="p-1 text-end">{gt("Saving")}</th>
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
                  <td className="p-1 text-end tabular-nums">{price(last[2] ?? 0, "hourly")}</td>
                  <td className="p-1 text-end tabular-nums">{price(last[1], "hourly")}</td>
                  <td className="p-1 text-end tabular-nums">{price(eff)}</td>
                  <td className="p-1 text-end tabular-nums">
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
      <table className="mt-2 w-full border-collapse bg-surface text-sm">
        <thead>
          <tr>
            <th className="pb-1 ps-2 text-start font-medium">{gt("Size")}</th>
            <th className="pb-1 ps-2 text-start font-medium">{gt("vCPUs")}</th>
            <th className="pb-1 ps-2 text-start font-medium">{gt("Memory")}</th>
          </tr>
        </thead>
        <tbody>
          {m.family.map((f) => {
            const self = f.name === m.name;
            return (
              <tr key={f.name} className={self ? "bg-ink text-surface" : "odd:bg-surface-2"}>
                <td className="border border-line p-1 ps-2">
                  {self ? (
                    f.name
                  ) : (
                    <Link
                      className={linkClass}
                      href={`${localePath(locale, instancePath(m.platform, f.name))}${suffix}`}
                    >
                      {f.name}
                    </Link>
                  )}
                </td>
                <td className="border border-line p-1 ps-2 tabular-nums">{f.vcpu ?? ""}</td>
                <td className="border border-line p-1 ps-2 tabular-nums">
                  <bdi>{f.memory ?? ""}</bdi>
                </td>
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
              href={`${localePath(locale, instancePath(m.platform, r.name))}${suffix}`}
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
