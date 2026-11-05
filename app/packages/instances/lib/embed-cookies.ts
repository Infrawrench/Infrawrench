/**
 * An in-memory `document.cookie` for the embeds. Import it before anything from
 * gt-react: `components/embed/EmbedI18nProvider.tsx` imports it first.
 *
 * gt-react keeps the page's locale in a cookie and otherwise falls back to the
 * browser's language, so a French embed turns English on hydration inside a
 * cross-site frame, where that cookie cannot be written. The embeds also promise
 * to store nothing, and show no consent prompt on that basis, so this applies
 * in the mobile popup as well, where a real cookie would work.
 */
if (typeof document !== "undefined") {
  const jar = new Map<string, string>();
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    set: (cookie: string) => {
      const pair = cookie.split(";", 1)[0]!;
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    },
  });
}

export {};
