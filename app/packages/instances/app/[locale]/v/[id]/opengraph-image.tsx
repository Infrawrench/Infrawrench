import { msg } from "gt-react";
import { ImageResponse } from "next/og";
import { displayColumns, formatCell, type Units } from "@/lib/chat/format";
import { loadView, viewData } from "@/lib/chat/views";
import { isLocale, localeDir } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { cardType, loadFonts, logo } from "@/lib/og";
import { cardText } from "@/lib/og-text";

/**
 * The share card, and the poster X shows before its player opens: the view's
 * title above its first rows. A chart's card is the same table: its rows are
 * what the chart draws, and Satori has no chart library to hand.
 */
export const revalidate = 1800;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A table of cloud instance prices";

export function generateStaticParams() {
  return [];
}

const MAX_ROWS = 6;
/** Two lines at the title's size. */
const MAX_TITLE = 90;
const MAX_COLUMNS = 5;

const C = {
  bg: "#060606",
  card: "#0d0d10",
  line: "#1f1f24",
  ink: "#f5f5f4",
  ink2: "#a1a1aa",
  ink3: "#6b7280",
} as const;

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) return new Response("Not found", { status: 404 });
  const [view, tr] = await Promise.all([loadView(id), getTranslator(locale)]);
  const data = view ? await viewData(view) : null;
  if (!data) return new Response("Not found", { status: 404 });

  const units: Units = {
    perHour: (price) => tr(msg("{price}/hr"), { price }),
    perMonth: (price) => tr(msg("{price}/mo"), { price }),
    gib: (amount) => tr(msg("{amount} GiB"), { amount }),
    yes: tr(msg("Yes")),
    no: tr(msg("No")),
  };
  const columns = displayColumns(data.view, data.result).slice(0, MAX_COLUMNS);
  const rows = data.result.rows
    .slice(0, MAX_ROWS)
    .map((row) => columns.map((c) => formatCell(row[c.index] ?? null, c.format, locale, units)));
  const heading = data.view.title;
  const instances = tr(msg("Instances"));
  const headers = columns.map((c) => c.label);
  const fonts = await loadFonts(
    locale,
    heading + instances + headers.join("") + rows.flat().join(""),
  );

  // Hebrew and Arabic mirror the card: the header and the table's columns.
  const rtl = localeDir(locale) === "rtl";
  const row = rtl ? "row-reverse" : "row";

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: 48,
        backgroundColor: C.bg,
        color: C.ink,
        ...cardType(locale),
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: row,
          alignItems: "center",
          gap: 14,
          fontSize: 26,
          color: C.ink2,
        }}
      >
        <img src={logo} width={40} height={40} style={{ borderRadius: 8 }} />
        {/* i18n-ignore: product name */}
        <span style={{ fontWeight: 600, color: C.ink }}>Infrawrench</span>
        <span style={{ display: "flex" }}>{cardText(locale, instances)}</span>
      </div>
      <div
        style={{
          display: "flex",
          flexShrink: 0,
          marginTop: 24,
          fontSize: 44,
          fontWeight: 800,
          lineHeight: locale === "ar" ? 1.4 : 1.15,
        }}
      >
        {cardText(
          locale,
          heading.length > MAX_TITLE ? `${heading.slice(0, MAX_TITLE)}…` : heading,
          {
            wrap: true,
          },
        )}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 24,
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          overflow: "hidden",
          border: `1px solid ${C.line}`,
          borderRadius: 14,
          backgroundColor: C.card,
          fontSize: 22,
        }}
      >
        {[headers, ...rows].map((cells, r) => (
          <div
            key={r}
            style={{
              display: "flex",
              flexDirection: row,
              padding: "9px 20px",
              borderTop: r === 0 ? "none" : `1px solid ${C.line}`,
              color: r === 0 ? C.ink3 : C.ink,
              fontWeight: r === 0 ? 600 : 400,
            }}
          >
            {cells.map((cell, c) => (
              <div
                key={c}
                style={{
                  display: "flex",
                  width: `${100 / columns.length}%`,
                  [rtl ? "paddingLeft" : "paddingRight"]: 16,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {cardText(locale, cell)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>,
    { ...size, ...(fonts ? { fonts } : {}) },
  );
}
