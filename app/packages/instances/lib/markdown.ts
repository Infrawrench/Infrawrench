import { attributeLabel, variantLabel, variantValueLabel } from "./attributes";
import { DURATIONS, effectiveHourly, leaseLabel, termLabel, termOptionKey } from "./format";
import type { Translate } from "./i18n/server";
import type { PlatformListing, PlatformSummary } from "./load";
import type { InstanceModel, RegionData } from "./model";
import { attributeTimelines } from "./selection";
import { defaultTermOption, priceHistory } from "./series";

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
  const regionTitle = region.code ? `${region.name} (${region.code})` : region.name;
  const variant = m.variants[m.defaultVariant]!;
  const variantText = m.shownKeys
    .map((k) => `${tr(variantLabel(m.variantKeys[k]!))}: ${tr(variantValueLabel(variant[k]!))}`)
    .join(", ");
  const out: string[] = [];

  out.push(`# ${m.name}`, "", `> ${opts.description}`, "");
  out.push(`- Platform: AWS ${m.platformLabel}`);
  out.push(`- First listed: ${day(m.createdAt)}`);
  if (m.deletedAt !== null) out.push(`- No longer listed by AWS since: ${day(m.deletedAt)}`);
  out.push(`- Price list as of: ${day(m.asOf)}`);
  out.push(`- Web page: ${opts.pageUrl}`);
  out.push(
    `- Prices are in USD from the AWS Price List bulk API. Add \`?region=<code>\` for another region's full history.`,
  );

  // Specifications, in this region, with every value an attribute has had.
  const timelines = attributeTimelines(m.attributes, data.region);
  const rows = [...timelines.entries()]
    .filter(([, steps]) => steps.at(-1)?.value != null)
    .sort((a, b) => tr(attributeLabel(a[0])).localeCompare(tr(attributeLabel(b[0]))));
  out.push("", `## Specifications in ${regionTitle}`, "");
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
  if (byRegion.length > 0) {
    out.push("", "## On-demand price by region", "", `${variantText}.`, "");
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
  if (here.length > 0) {
    out.push("", `## On-demand price by variant in ${regionTitle}`, "");
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
    out.push("", `## Reserved prices in ${regionTitle}`, "", `${variantText}.`, "");
    out.push(
      table(
        ["Term", "Upfront USD", "USD per hour", "Effective USD per hour"],
        reserved
          .sort(
            (a, b) =>
              a.t.lease.localeCompare(b.t.lease) ||
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

  // Price history: every change, newest first.
  const series = priceHistory(m, data, m.defaultVariant, defaultTermOption(m));
  const times = [...new Set(series.flatMap((s) => s.points.map(([at]) => at)))].sort(
    (a, b) => b - a,
  );
  if (times.length > 0) {
    const option = m.terms.find((t) => termOptionKey(t) === defaultTermOption(m));
    out.push("", `## Price history in ${regionTitle}`, "");
    out.push(
      `${variantText}. USD per hour; reserved prices are effective hourly (${option ? termLabel(option, tr) : "standard"}, upfront spread over the term).`,
      "",
    );
    out.push(
      table(
        ["Date", ...series.map((s) => tr(s.label))],
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

  if (m.availability.length > 0) {
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

/** The index as Markdown: every service, with a link to its listing. */
export function renderIndexMarkdown(platforms: PlatformSummary[], tr: Translate): string {
  const out = [
    "# AWS instance types",
    "",
    "> Specs and prices for every instance type in AWS's compute-priced services, in every region, with the full history of both, from the AWS Price List bulk API.",
    "",
    `Append \`.md\` to any page (or send \`Accept: text/markdown\`) for Markdown. The same data is available through the [bulk instances API](https://infrawrench.com/docs/team-and-billing/bulk-instances-api). People can also ask questions about it in plain language at ${SITE}/, which answers from the same price lists.`,
    "",
    table(
      ["Service", "What it is", "Instance types", "Families", "Markdown"],
      platforms.map((p) => [
        `[AWS ${p.label}](${SITE}/aws/${p.platform})`,
        tr(p.summary),
        String(p.instances),
        String(p.families),
        `${SITE}/aws/${p.platform}.md`,
      ]),
    ),
  ];
  return `${out.join("\n")}\n`;
}

/** A service's listing as Markdown: every family and its instance types. */
export function renderPlatformMarkdown(listing: PlatformListing, tr: Translate): string {
  const out = [
    `# AWS ${listing.label} instance types`,
    "",
    `> ${tr(listing.summary)}. ${listing.instances} instance types in ${listing.families.length} families.`,
    "",
    `Each instance's page is \`${SITE}/aws/${listing.platform}/<instance>\`; append \`.md\` for Markdown.`,
  ];
  for (const f of listing.families) {
    out.push("", `## ${f.key ? f.label : "Other"}`, "");
    out.push(
      f.instances.map((n) => `- [${n}](${SITE}/aws/${listing.platform}/${n}.md)`).join("\n"),
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
