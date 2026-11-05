// The logo, 80px (the cards draw it at 40), inlined as a data URL at build time.
import logo from "./og-logo.png?inline";

export { logo };

/** Inter has no CJK glyphs; these carry Japanese and Chinese, with Inter still drawing the Latin. */
export const CJK_FAMILIES: Readonly<Record<string, string>> = {
  ja: "Noto Sans JP",
  zh: "Noto Sans SC",
};

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

/** The card's fonts: `text` is every string it draws, for the CJK subset. */
export async function loadFonts(locale: string, text: string) {
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
