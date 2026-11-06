"use client";

import { useGT, useLocale } from "gt-react";
import { formatDate } from "@/lib/format";
import { localePath } from "@/lib/i18n/locales";
import type { InstanceModel } from "@/lib/model";
import { instancePath } from "@/lib/platforms";
import { StepChart } from "../charts/StepChart";
import { PriceRow, PricingNotes, PricingPickers, useInstancePricing } from "../InstancePricing";
import { EmbedBrand, EmbedShell, clicked } from "./EmbedShell";

/**
 * The instance page's first screen for an X Player Card: what it costs, the
 * pickers that change that most, and the price history. Everything else is one
 * link away, on the full page, which keeps what was picked here.
 */
export function InstanceEmbed({ model: m }: { model: InstanceModel }) {
  const gt = useGT();
  const locale = useLocale();
  const pricing = useInstancePricing(m, { rememberCurrency: false });
  const { history, fmt, spotEnd, regionName, oneRegion, provider, suffix } = pricing;
  const fullHref = `${localePath(locale, instancePath(m.platform, m.name))}${suffix}`;

  return (
    <EmbedShell kind="instance" fullHref={fullHref} fullLabel={gt("Open full page")}>
      <main id="main-content" tabIndex={-1} className="flex flex-col gap-3 p-3">
        <header>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <h1 className="text-lg font-bold">{m.name}</h1>
              <span className="text-xs text-ink-2">
                {provider} {m.platformLabel}
              </span>
            </div>
            <EmbedBrand kind="instance" />
          </div>
          <a
            className="text-xs text-accent hover:text-accent-hover hover:underline"
            href={fullHref}
            target="_blank"
            rel="noopener"
            onClick={() => clicked("instance", "specs")}
          >
            {gt("See all specifications on the full page")}
          </a>
        </header>
        {m.deletedAt !== null && (
          <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-xs">
            {gt("{provider} stopped listing {name} on {date}. The history below runs up to then.", {
              provider,
              name: m.name,
              date: formatDate(m.deletedAt, locale),
            })}
          </p>
        )}
        <section>
          <PriceRow pricing={pricing} />
          <PricingNotes pricing={pricing} spot={false} />
        </section>
        <div className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-4">
          <PricingPickers pricing={pricing} variants={false} regionClassName="" />
        </div>
        <StepChart
          series={history}
          end={m.deletedAt ?? spotEnd}
          format={fmt}
          height={150}
          label={
            oneRegion
              ? gt("Price history of {name}", { name: m.name })
              : gt("Price history of {name} in {region}", { name: m.name, region: regionName })
          }
        />
      </main>
    </EmbedShell>
  );
}
