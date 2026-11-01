import { msg } from "gt-react";
import { ImageResponse } from "next/og";
// The logo, 80px (the card draws it at 40), inlined as a data URL at build time.
import logo from "./og-logo.png?inline";
import { specs } from "@/lib/attributes";
import { formatDate, formatMoney } from "@/lib/format";
import { isLocale } from "@/lib/i18n/locales";
import { getTranslator, type Translate } from "@/lib/i18n/server";
import { loadInstance } from "@/lib/load";
import { latestAttributes, spotSystem, type InstanceModel } from "@/lib/model";
import { defaultTermOption, priceHistory, type PriceSeries } from "@/lib/series";
import { stepPaths } from "@/lib/step-path";
import { timeTicks } from "@/lib/time-ticks";

/**
 * The share card: the instance's specs beside its price history in the region
 * the page opens on. Rendered by Satori, so every element with more than one
 * child is a flex box and the chart's labels are HTML around the SVG (SVG text
 * would need its own font loading).
 */
export const revalidate = 1800;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Instance specs and price history";

export function generateStaticParams() {
  return [];
}

const C = {
  bg: "#060606",
  card: "#0d0d10",
  line: "#1f1f24",
  ink: "#f5f5f4",
  ink2: "#a1a1aa",
  ink3: "#6b7280",
  accent: "#60a5fa",
  od: "#3987e5",
  "1yr": "#d95926",
  "3yr": "#199e70",
  // The spot line and sparkline; not a series of the main chart.
  spot: "#c98500",
} as const;

/**
 * The card's inner width is 470: 1200 - 2 * 56 page padding - 520 specs - 40
 * gap - 2 * 28 card padding - borders. The price labels take a gutter of it.
 */
const GUTTER = 70;
const CHART = { width: 470 - GUTTER, height: 180 };

/** Inter has no CJK glyphs; these carry Japanese and Chinese, with Inter still drawing the Latin. */
const CJK_FAMILIES: Readonly<Record<string, string>> = { ja: "Noto Sans JP", zh: "Noto Sans SC" };

/**
 * Faces of one family from Google Fonts, which serves TTF (what Satori reads)
 * to non-browser clients. `text` subsets the font to the glyphs the card
 * uses, which keeps a CJK face to a few kilobytes. Cached at the edge.
 */
async function loadFamily(family: string, text?: string) {
  const query = `family=${encodeURIComponent(family)}:wght@400;600;800${text ? `&text=${encodeURIComponent(text)}` : ""}`;
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?${query}`, {
      cf: { cacheTtl: 86400 * 30, cacheEverything: true },
    })
  ).text();
  const faces = [...css.matchAll(/font-weight:\s*(\d+);[\s\S]*?src:\s*url\(([^)]+)\)/g)];
  return Promise.all(
    faces.map(async ([, weight, url]) => ({
      name: family,
      weight: Number(weight) as 400 | 600 | 800,
      style: "normal" as const,
      data: await (
        await fetch(url!, { cf: { cacheTtl: 86400 * 365, cacheEverything: true } })
      ).arrayBuffer(),
    })),
  );
}

async function loadFonts(locale: string, text: string) {
  try {
    const cjk = CJK_FAMILIES[locale];
    const [latin, extra] = await Promise.all([
      loadFamily("Inter"),
      cjk ? loadFamily(cjk, text) : Promise.resolve([]),
    ]);
    return [...latin, ...extra];
  } catch {
    return undefined; // Satori's bundled font, regular weight only.
  }
}

function chartGeometry(series: PriceSeries[], end: number, locale: string) {
  const plotted = series.filter((s) => s.points.some(([, v]) => v !== null));
  const values = plotted.flatMap((s) => s.points.flatMap(([, v]) => (v === null ? [] : [v])));
  if (values.length === 0) return null;
  const t0 = Math.min(...plotted.map((s) => s.points[0]![0]));
  const t1 = Math.max(end, ...plotted.map((s) => s.points.at(-1)![0])) + 86400;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo) * 0.15 || hi * 0.15 || 1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * CHART.width;
  const y = (v: number) => CHART.height - ((v - lo) / (hi - lo)) * CHART.height;
  const paths = plotted.map((s) => {
    const { solid, dashed, dots, contiguous } = stepPaths(s.points, t1, x, y);
    const start = x(s.points[0]![0]).toFixed(1);
    const area = contiguous ? `${solid}V${CHART.height}H${start}Z` : null;
    return {
      id: s.id,
      solid,
      dashed,
      area,
      // A dot wherever the price changed, unless there are too many to read.
      dots: dots.length <= 40 ? dots.map((d) => ({ cx: x(d.at), cy: y(d.value) })) : [],
    };
  });
  const gridValues = [0.2, 0.5, 0.8].map((f) => lo + (hi - lo) * f);
  const years = timeTicks(t0, t1, locale).map((t) => ({ label: t.label, left: x(t.at) }));
  return { paths, years, grid: gridValues.map((v) => ({ value: v, top: y(v) })) };
}

/** The spot sparkline beside the spot price. */
const SPARK = { width: 120, height: 24 };

/**
 * A step line through the spot history (one region, one operating system),
 * scaled to its own range so the movement shows; null without two prices.
 */
function sparkline(points: [number, number | null][]): string | null {
  const priced = points.filter((p): p is [number, number] => p[1] !== null);
  if (priced.length < 2) return null;
  const t0 = priced[0]![0];
  const t1 = priced.at(-1)![0];
  const lo = Math.min(...priced.map(([, v]) => v));
  const hi = Math.max(...priced.map(([, v]) => v));
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * SPARK.width);
  // 2px of room top and bottom for the stroke; a flat history sits in the middle.
  const y = (v: number) =>
    hi === lo ? SPARK.height / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (SPARK.height - 4);
  let d = `M${x(priced[0]![0]).toFixed(1)},${y(priced[0]![1]).toFixed(1)}`;
  for (const [t, v] of priced.slice(1)) d += `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`;
  return `${d}H${SPARK.width}`;
}

function specRows(m: InstanceModel, tr: Translate): [string, string][] {
  const a = latestAttributes(m.attributes);
  const { vcpu, memory } = specs(a);
  const known = (v: string | undefined) => (v && v !== "NA" && v !== "0" ? v : undefined);
  const rows: [string, string | undefined][] = [
    [tr(msg("vCPUs")), vcpu],
    [tr(msg("Memory")), memory],
    [tr(msg("GPUs")), known(a.gpu)],
    [tr(msg("Processor")), known(a.physicalProcessor ?? a.physicalCpu)],
    [tr(msg("Network")), known(a.networkPerformance)],
    [tr(msg("Storage")), known(a.storage)],
    [tr(msg("Clock speed")), known(a.clockSpeed)],
    [tr(msg("Architecture")), known(a.processorArchitecture)],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== undefined).slice(0, 6);
}

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; platform: string; instance: string }>;
}) {
  const { locale, platform, instance } = await params;
  if (!isLocale(locale)) return new Response("Not found", { status: 404 });
  const [m, tr] = await Promise.all([
    loadInstance(platform, decodeURIComponent(instance)),
    getTranslator(locale),
  ]);
  if (!m) return new Response("Not found", { status: 404 });
  const money = (usd: number) => formatMoney(usd, undefined, locale);

  const region = m.regions[m.defaultRegion]!;
  const all = priceHistory(m, m.regionData, m.defaultVariant, defaultTermOption(m));
  // Spot has its own line and sparkline: its 90 days would be a sliver at the
  // end of a chart that runs back to when the instance was first listed.
  const series = all.filter((s) => s.id !== "spot");
  const spotTrend = sparkline(all.find((s) => s.id === "spot")?.points ?? []);
  const chart = chartGeometry(series, m.deletedAt ?? m.asOf, locale);
  const onDemand = m.current[m.defaultRegion]?.find(([v]) => v === m.defaultVariant)?.[1];
  // EC2's spot price for the same variant and region, when spot applies to it.
  const system = spotSystem(m, m.defaultVariant);
  const spotNow =
    system < 0 || m.deletedAt !== null
      ? undefined
      : m.spot?.current[m.defaultRegion]?.find(([s]) => s === system)?.[1];
  const latest = (s: PriceSeries) => s.points.at(-1)?.[1] ?? null;
  const lastPrice = [...series[0]!.points].reverse().find(([, v]) => v !== null)?.[1] ?? undefined;
  const regionsOffering = m.current.filter((pairs) => pairs.length > 0).length;
  const family = latestAttributes(m.attributes).instanceFamily;
  const nameSize = m.name.length > 13 ? Math.max(40, Math.floor((72 * 13) / m.name.length)) : 72;
  const rows = specRows(m, tr);

  // Every piece of text, translated up front: the CJK fonts are subset to it.
  const text = {
    instances: tr(msg("Instances")),
    headline:
      m.deletedAt !== null
        ? tr(msg("Retired"))
        : onDemand !== undefined
          ? money(onDemand)
          : tr(msg("N/A")),
    perHour: tr(msg("per hour on demand")),
    where:
      m.deletedAt !== null
        ? lastPrice !== undefined
          ? tr(msg("AWS stopped listing it on {date}; last {price}/hr"), {
              date: formatDate(m.deletedAt, locale),
              price: money(lastPrice),
            })
          : tr(msg("AWS stopped listing it on {date}"), { date: formatDate(m.deletedAt, locale) })
        : region.name,
    spot:
      spotNow === undefined
        ? null
        : onDemand
          ? tr(msg("{price}/hr spot, {saving} less"), {
              price: money(spotNow),
              saving: new Intl.NumberFormat(locale, {
                style: "percent",
                maximumFractionDigits: 0,
              }).format(1 - spotNow / onDemand),
            })
          : tr(msg("{price}/hr spot"), { price: money(spotNow) }),
    legend: series.map((s) => {
      const v = latest(s);
      // "RI" keeps three entries with prices inside the card's width.
      const name =
        s.id === "od"
          ? tr(msg("On demand"))
          : s.id === "1yr"
            ? tr(msg("1-yr RI"))
            : tr(msg("3-yr RI"));
      return { id: s.id, label: s.id !== "od" && v !== null ? `${name} ${money(v)}` : name };
    }),
    noHistory: tr(msg("No price history")),
    listedSince: tr(msg("Listed since {date}"), { date: formatDate(m.createdAt, locale) }),
    offeredIn: tr(msg("Offered in {count, plural, one {# region} other {# regions}}"), {
      count: regionsOffering,
    }),
    fullHistory: tr(msg("Full price and spec history")),
  };
  const fonts = await loadFonts(
    locale,
    JSON.stringify(text) +
      rows.flat().join("") +
      (family ?? "") +
      chart?.years.map((y) => y.label).join(""),
  );

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "48px 56px",
        background: C.bg,
        color: C.ink,
        fontFamily: CJK_FAMILIES[locale] ? `Inter, "${CJK_FAMILIES[locale]}"` : "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <img src={logo} width={40} height={40} style={{ borderRadius: 9 }} />
          <div style={{ display: "flex", fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
            {/* i18n-ignore: product name */}
            Infrawrench
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 16,
              fontWeight: 600,
              color: C.ink2,
              border: `1px solid ${C.line}`,
              borderRadius: 999,
              padding: "4px 14px",
            }}
          >
            {text.instances}
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 20, color: C.ink3 }}>
          {/* i18n-ignore: hostname */}
          instances.infrawrench.com
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, marginTop: 36, gap: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 520 }}>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              fontWeight: 600,
              color: C.accent,
              letterSpacing: 2,
            }}
          >
            {`AWS ${m.platformLabel.toUpperCase()}`}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: nameSize,
              fontWeight: 800,
              letterSpacing: -2,
              marginTop: 4,
            }}
          >
            {m.name}
          </div>
          {family && (
            <div style={{ display: "flex", fontSize: 24, color: C.ink2, marginTop: 2 }}>
              {family}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 28, rowGap: 22 }}>
            {rows.map(([label, value]) => (
              <div
                key={label}
                style={{ display: "flex", flexDirection: "column", width: 260, paddingRight: 16 }}
              >
                <div
                  style={{
                    display: "flex",
                    fontSize: 16,
                    color: C.ink3,
                    letterSpacing: 1,
                  }}
                >
                  {label}
                </div>
                <div
                  style={{
                    display: "flex",
                    fontSize: value.length > 20 ? 18 : value.length > 16 ? 21 : 26,
                    fontWeight: 600,
                    marginTop: 2,
                  }}
                >
                  {value.length > 28 ? `${value.slice(0, 27)}…` : value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 22,
            padding: "26px 28px 20px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            {/* The price never shrinks; a long "per hour" (fr, es) wraps beside it instead. */}
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                fontSize: 52,
                fontWeight: 800,
                letterSpacing: -1.5,
              }}
            >
              {text.headline}
            </div>
            {m.deletedAt === null && onDemand !== undefined && (
              <div style={{ display: "flex", fontSize: 22, color: C.ink2 }}>{text.perHour}</div>
            )}
          </div>
          <div
            style={{ display: "flex", flexShrink: 0, fontSize: 18, color: C.ink3, marginTop: 2 }}
          >
            {text.where}
          </div>
          {text.spot && (
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                alignItems: "center",
                gap: 14,
                marginTop: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  // One line beside the sparkline, so longer translations (de, fr) step down.
                  fontSize: text.spot.length > 28 ? 17 : 20,
                  fontWeight: 600,
                  color: C.spot,
                  whiteSpace: "nowrap",
                }}
              >
                {text.spot}
              </div>
              {spotTrend && (
                <svg
                  style={{ flexShrink: 0 }}
                  width={SPARK.width}
                  height={SPARK.height}
                  viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
                >
                  <path
                    d={spotTrend}
                    fill="none"
                    stroke={C.spot}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
          )}
          {/* The spot row takes the room these margins would. */}
          <div style={{ display: "flex", gap: 20, marginTop: text.spot ? 10 : 18 }}>
            {text.legend.map((s) => {
              return (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 16,
                    color: C.ink2,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: 16,
                      height: 4,
                      borderRadius: 2,
                      background: C[s.id],
                    }}
                  />
                  {s.label}
                </div>
              );
            })}
          </div>
          {chart ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                marginTop: text.spot ? 6 : 16,
              }}
            >
              <div style={{ display: "flex" }}>
                <div
                  style={{
                    display: "flex",
                    position: "relative",
                    width: GUTTER,
                    height: CHART.height,
                  }}
                >
                  {chart.grid.map((g) => (
                    <div
                      key={g.value}
                      style={{
                        display: "flex",
                        position: "absolute",
                        left: 0,
                        top: g.top - 9,
                        fontSize: 14,
                        color: C.ink3,
                      }}
                    >
                      {money(g.value)}
                    </div>
                  ))}
                </div>
                <svg
                  width={CHART.width}
                  height={CHART.height}
                  viewBox={`0 0 ${CHART.width} ${CHART.height}`}
                >
                  <defs>
                    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.od} stopOpacity="0.28" />
                      <stop offset="100%" stopColor={C.od} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {chart.grid.map((g) => (
                    <line
                      key={g.value}
                      x1="0"
                      x2={CHART.width}
                      y1={g.top}
                      y2={g.top}
                      stroke={C.line}
                      strokeWidth="1"
                    />
                  ))}
                  {chart.paths.map((p) =>
                    p.id === "od" && p.area ? (
                      <path key="area" d={p.area} fill="url(#fill)" />
                    ) : null,
                  )}
                  {[...chart.paths]
                    .reverse()
                    .flatMap((p) => [
                      p.dashed ? (
                        <path
                          key={`${p.id}-gap`}
                          d={p.dashed}
                          fill="none"
                          stroke={C[p.id]}
                          strokeWidth="2.5"
                          strokeDasharray="7 5"
                          opacity="0.7"
                        />
                      ) : null,
                      <path
                        key={p.id}
                        d={p.solid}
                        fill="none"
                        stroke={C[p.id]}
                        strokeWidth="3.5"
                        strokeLinejoin="round"
                      />,
                    ])}
                  {chart.paths.flatMap((p) =>
                    p.dots.map((dot) => (
                      <circle
                        key={`${p.id}-${dot.cx}`}
                        cx={dot.cx}
                        cy={dot.cy}
                        r="5"
                        fill={C[p.id]}
                        stroke={C.card}
                        strokeWidth="2.5"
                      />
                    )),
                  )}
                </svg>
              </div>
              <div
                style={{
                  display: "flex",
                  position: "relative",
                  height: 26,
                  marginTop: 6,
                  marginLeft: GUTTER,
                  width: CHART.width,
                }}
              >
                {chart.years.map((yr) => (
                  <div
                    key={yr.label}
                    style={{
                      display: "flex",
                      position: "absolute",
                      left: yr.left - 30,
                      width: 60,
                      justifyContent: "center",
                      fontSize: 15,
                      color: C.ink3,
                    }}
                  >
                    {yr.label}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flex: 1,
                alignItems: "center",
                color: C.ink3,
                fontSize: 20,
              }}
            >
              {text.noHistory}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 28, fontSize: 18, color: C.ink3, marginTop: 22 }}>
        <div style={{ display: "flex" }}>{text.listedSince}</div>
        {regionsOffering > 0 && <div style={{ display: "flex" }}>{text.offeredIn}</div>}
        <div style={{ display: "flex" }}>{text.fullHistory}</div>
      </div>
    </div>,
    { ...size, ...(fonts ? { fonts } : {}) },
  );
}
