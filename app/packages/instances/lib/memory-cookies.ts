/**
 * An in-memory `document.cookie`, for pages inside a cross-site frame.
 *
 * gt-react keeps the page's locale in a cookie and otherwise falls back to the
 * browser's language, so a French page turns English on hydration where that
 * cookie cannot be written. Install this before anything from gt-react runs.
 */
let installed = false;

export function installMemoryCookies(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
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
