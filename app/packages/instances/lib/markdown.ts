import { attributeLabel, variantLabel, variantValueLabel } from "./attributes";
import {
  DURATIONS,
  effectiveHourly,
  leaseLabel,
  leaseMonths,
  termLabel,
  termOptionKey,
} from "./format";
import type { Translate } from "./i18n/server";
import type { PlatformListing, PlatformSummary } from "./load";
import { latestAttributes, spotSystem, type InstanceModel, type RegionData } from "./model";
import { attributeTimelines } from "./selection";
import {
  CLOUDS,
  CLOUD_IDS,
  cloudOf,
  fullLabel,
  instancePath,
  platformPath,
  type Cloud,
} from "./platforms";
import { defaultTermOption, priceHistory, seriesLabel } from "./series";

/** Where each cloud's prices come from, for the line under an instance's facts. */
const SOURCES: Readonly<Record<Cloud, string>> = {
  aws: "the AWS Price List bulk API",
  alibaba: "Alibaba Cloud's ECS price list (the international site)",
  runpod:
    "RunPod's public API; RunPod charges the same in every data center, so every price is in the location `global`",
};

/**
 * The instance page as Markdown, for agents: what `proxy.ts` serves when a
 * request prefers `text/markdown` or asks for `<page>.md`. Plain tables of
 * the same data the page shows, in English, USD, ISO dates. `region` is the
 * one whose full history is included (the page's default unless `?region=`).
 */
export function renderMarkdown(
  m: InstanceModel,
  data: RegionData,
  opts: { description: string; pageUrl: string; tr: Translate },
): string {
  const { tr } = opts;
  const region = m.regions[data.region]!;
  const regionTitle =
    region.code && region.code !== region.name ? `${region.name} (${region.code})` : region.name;
  const variant = m.variants[m.defaultVariant]!;
  const variantText = m.shownKeys
    .map((k) => `${tr(variantLabel(m.variantKeys[k]!))}: ${tr(variantValueLabel(variant[k]!))}`)
    .join(", ");
  // RunPod has one location, `global`, so nothing is "in" a region there.
  const oneRegion = m.regions.length <= 1;
  const inRegion = oneRegion ? "" : ` in ${regionTitle}`;
  /** `variantText` as a sentence of its own, then `rest`; nothing when the platform has no variants. */
  const lead = (rest = "") =>
    [variantText ? `${variantText}.` : "", rest].filter(Boolean).join(" ");
  const out: string[] = [];

  out.push(`# ${m.name}`, "", `> ${opts.description}`, "");
  const cloud = cloudOf(m.platform);
  out.push(`- Platform: ${fullLabel(m.platform)}`);
  out.push(`- First listed: ${day(m.createdAt)}`);
  if (m.deletedAt !== null)
    out.push(`- No longer listed by ${CLOUDS[cloud].label} since: ${day(m.deletedAt)}`);
  out.push(`- Price list as of: ${day(m.asOf)}`);
  out.push(`- Web page: ${opts.pageUrl}`);
  out.push(
    `- Prices are in USD from ${SOURCES[cloud]}${m.spot ? ", and spot prices from AWS's Spot pricing page" : ""}.${m.regions.length > 1 ? " Add `?region=<code>` for another region's full history." : ""}`,
  );
  if (latestAttributes(m.attributes).priceUnit === "GPU-Hour") {
    out.push("- Prices are per GPU per hour; a pod can have several GPUs.");
  }

  // Specifications, in this region, with every value an attribute has had.
  const timelines = attributeTimelines(m.attributes, data.region);
  const rows = [...timelines.entries()]
    .filter(([, steps]) => steps.at(-1)?.value != null)
    .sort((a, b) => tr(attributeLabel(a[0])).localeCompare(tr(attributeLabel(b[0]))));
  out.push("", `## Specifications${inRegion}`, "");
  out.push(
    table(
      ["Attribute", "Key", "Value", "Earlier values"],
      rows.map(([key, steps]) => [
        tr(attributeLabel(key)),
        `\`${key}\``,
        steps.at(-1)!.value!,
        steps
          .slice(0, -1)
          .map((s) => `${day(s.at)}: ${s.value ?? "removed"}${s.regional ? " (this region)" : ""}`)
          .join("; "),
      ]),
    ),
  );

  // The default variant everywhere it is offered.
  const byRegion = m.regions
    .flatMap((r, i) => {
      const hourly = m.current[i]?.find(([v]) => v === m.defaultVariant)?.[1];
      return hourly === undefined ? [] : [{ r, hourly }];
    })
    .sort((a, b) => a.hourly - b.hourly);
  if (!oneRegion && byRegion.length > 0) {
    out.push("", "## On-demand price by region", "");
    if (variantText) out.push(lead(), "");
    out.push(
      table(
        ["Region", "Code", "USD per hour", "USD per month"],
        byRegion.map(({ r, hourly }) => [
          r.name,
          r.code ?? "",
          usd(hourly),
          usd(hourly * DURATIONS.monthly.hours),
        ]),
      ),
    );
  }

  // Every variant in this region.
  const here = m.current[data.region] ?? [];
  if (here.length > 0 && m.shownKeys.length > 0) {
    out.push("", `## On-demand price by variant${inRegion}`, "");
    out.push(
      table(
        [...m.shownKeys.map((k) => tr(variantLabel(m.variantKeys[k]!))), "USD per hour"],
        [...here]
          .sort((a, b) => a[1] - b[1])
          .map(([v, hourly]) => [
            ...m.shownKeys.map((k) => tr(variantValueLabel(m.variants[v]![k]!))),
            usd(hourly),
          ]),
      ),
    );
  }

  // Reserved terms for the default variant here.
  const reserved = m.terms.flatMap((t, i) => {
    const last = data.reserved[`${m.defaultVariant}:${i}`]?.at(-1);
    return last && last[1] !== null ? [{ t, hourly: last[1], upfront: last[2] ?? 0 }] : [];
  });
  if (reserved.length > 0) {
    out.push("", `## Reserved prices${inRegion}`, "");
    if (variantText) out.push(lead(), "");
    out.push(
      table(
        ["Term", "Upfront USD", "USD per hour", "Effective USD per hour"],
        reserved
          .sort(
            (a, b) =>
              (leaseMonths(a.t.lease) ?? 0) - (leaseMonths(b.t.lease) ?? 0) ||
              effectiveHourly(a.t, a.hourly, a.upfront) - effectiveHourly(b.t, b.hourly, b.upfront),
          )
          .map(({ t, hourly, upfront }) => [
            `${leaseLabel(t.lease, tr)}, ${termLabel(t, tr)}`,
            usd(upfront),
            usd(hourly),
            usd(effectiveHourly(t, hourly, upfront)),
          ]),
      ),
    );
  }

  // Spot, for EC2 variants it applies to: every region now, and this region's history by day.
  const system = spotSystem(m, m.defaultVariant);
  if (m.spot && system >= 0) {
    const spot = m.spot;
    const bySpot = m.regions
      .flatMap((r, i) => {
        const hourly = spot.current[i]?.find(([s]) => s === system)?.[1];
        const onDemand = m.current[i]?.find(([v]) => v === m.defaultVariant)?.[1];
        return hourly === undefined ? [] : [{ r, hourly, onDemand }];
      })
      .sort((a, b) => a.hourly - b.hourly);
    if (bySpot.length > 0) {
      out.push("", "## Spot price by region", "");
      out.push(
        `${variantText}. The lowest spot price across each region's availability zones, as of ${day(spot.asOf)}.`,
        "",
      );
      out.push(
        table(
          ["Region", "Code", "USD per hour", "Saving on on demand"],
          bySpot.map(({ r, hourly, onDemand }) => [
            r.name,
            r.code ?? "",
            usd(hourly),
            onDemand ? `${Math.round((1 - hourly / onDemand) * 100)}%` : "",
          ]),
        ),
      );
    }
    const rows = data.spot?.[system] ?? [];
    if (rows.length > 0) {
      // Spot prices change many times a day; the last price of each day it changed.
      const byDay = new Map<string, number | null>();
      for (const [at, hourly] of rows) byDay.set(day(at), hourly);
      out.push("", `## Spot price history in ${regionTitle}`, "");
      out.push(`${variantText}. USD per hour, the last price of each day it changed (UTC).`, "");
      out.push(
        table(
          ["Date", "USD per hour"],
          [...byDay.entries()]
            .reverse()
            .map(([date, hourly]) => [date, hourly === null ? "not offered" : usd(hourly)]),
        ),
      );
    }
  }

  // Price history: every change, newest first. Spot has its own section above.
  const series = priceHistory(m, data, m.defaultVariant, defaultTermOption(m)).filter(
    (s) => s.id !== "spot",
  );
  const times = [...new Set(series.flatMap((s) => s.points.map(([at]) => at)))].sort(
    (a, b) => b - a,
  );
  if (times.length > 0) {
    const option = m.terms.find((t) => termOptionKey(t) === defaultTermOption(m));
    out.push("", `## Price history${inRegion}`, "");
    out.push(
      lead(
        option
          ? `USD per hour; reserved prices are effective hourly (${termLabel(option, tr)}, upfront spread over the term).`
          : "USD per hour.",
      ),
      "",
    );
    out.push(
      table(
        ["Date", ...series.map((s) => seriesLabel(m, s, tr))],
        times.map((t) => [
          day(t),
          ...series.map((s) => {
            const at = [...s.points].reverse().find(([when]) => when <= t);
            return at === undefined ? "" : at[1] === null ? "not offered" : usd(at[1]);
          }),
        ]),
      ),
    );
  }

  if (m.regions.length > 1 && m.availability.length > 0) {
    out.push("", "## Regions offering it on demand over time", "");
    out.push(
      table(
        ["Date", "Regions"],
        [...m.availability].reverse().map(([at, n]) => [day(at), String(n)]),
      ),
    );
  }

  if (m.family.length > 1) {
    out.push("", "## Family sizes", "");
    out.push(
      table(
        ["Instance", "vCPUs", "Memory"],
        m.family.map((f) => [
          f.name === m.name ? `**${f.name}**` : f.name,
          f.vcpu ?? "",
          f.memory ?? "",
        ]),
      ),
    );
  }
  if (m.related.length > 0) {
    out.push(
      "",
      "## Related families",
      "",
      m.related.map((r) => `- ${r.family}: ${r.name}`).join("\n"),
    );
  }
  return `${out.join("\n")}\n`;
}

const SITE = "https://instances.infrawrench.com";

function servicesTable(platforms: PlatformSummary[], tr: Translate): string {
  return table(
    ["Service", "What it is", "Instance types", "Families", "Markdown"],
    platforms.map((p) => [
      `[${fullLabel(p.platform)}](${SITE}${platformPath(p.platform)})`,
      tr(p.summary),
      String(p.instances),
      String(p.families),
      `${SITE}${platformPath(p.platform)}.md`,
    ]),
  );
}

const ABOUT = `Append \`.md\` to any page (or send \`Accept: text/markdown\`) for Markdown. The same data is available through the [bulk instances API](https://infrawrench.com/docs/team-and-billing/bulk-instances-api). People can also ask questions about it in plain language at ${SITE}/, which answers from the same price lists, and programs can query them in SQL with the [instance pricing SQL API](https://infrawrench.com/docs/team-and-billing/instance-pricing-api).`;

/** The index as Markdown: every cloud's services, with a link to each listing. */
export function renderIndexMarkdown(platforms: PlatformSummary[], tr: Translate): string {
  const out = [
    "# Cloud instance types",
    "",
    "> Specs and prices for every instance type in AWS's compute-priced services, Alibaba Cloud ECS and RunPod's GPU and CPU pods, in every region, with the full history of both, from each provider's own price lists.",
    "",
    ABOUT,
  ];
  for (const cloud of CLOUD_IDS) {
    const mine = platforms.filter((p) => p.cloud === cloud);
    if (mine.length === 0) continue;
    out.push("", `## ${CLOUDS[cloud].label}`, "", `Every service: ${SITE}/${cloud}`, "");
    out.push(servicesTable(mine, tr));
  }
  return `${out.join("\n")}\n`;
}

/** One cloud's services as Markdown. */
export function renderCloudMarkdown(
  cloud: Cloud,
  platforms: PlatformSummary[],
  tr: Translate,
): string {
  const out = [
    `# ${CLOUDS[cloud].label} instance types`,
    "",
    `> Specs and prices for every ${CLOUDS[cloud].label} instance type, in every region, with the full history of both, from ${SOURCES[cloud]}.`,
    "",
    ABOUT,
    "",
    servicesTable(platforms, tr),
  ];
  return `${out.join("\n")}\n`;
}

/** A service's listing as Markdown: every family and its instance types. */
export function renderPlatformMarkdown(listing: PlatformListing, tr: Translate): string {
  const out = [
    `# ${fullLabel(listing.platform)} instance types`,
    "",
    `> ${tr(listing.summary)}. ${listing.instances} instance types in ${listing.families.length} families.`,
    "",
    `Each instance's page is \`${SITE}${platformPath(listing.platform)}/<instance>\` (the name URL-encoded); append \`.md\` for Markdown.`,
  ];
  for (const f of listing.families) {
    out.push("", `## ${f.key ? f.label : tr(listing.otherLabel ?? "Other")}`, "");
    out.push(
      f.instances.map((n) => `- [${n}](${SITE}${instancePath(listing.platform, n)}.md)`).join("\n"),
    );
  }
  return `${out.join("\n")}\n`;
}

function day(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function usd(value: number): string {
  return `$${Number(value.toPrecision(6))}`;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}
