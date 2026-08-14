/**
 * Gives the renderer a working `document.cookie` when the origin has no cookie
 * jar, backing it with localStorage.
 *
 * The packaged app loads the renderer from `file://`, where Chromium accepts a
 * `document.cookie` write and silently discards it. That breaks gt-react's
 * language picker outright: `getLocale()` resolves against
 * `[cookie, ...navigator.languages, _getLocale()]` in that order, so with no
 * cookie the OS language always wins and picking a language appears to do
 * nothing — the app reloads and comes back in the same locale. `_getLocale` is
 * a last-resort fallback, not an override, so passing the stored choice there
 * cannot fix it; the cookie is the only slot that outranks the OS language.
 *
 * Feature-detected rather than protocol-sniffed: `electron-vite dev` serves the
 * renderer over http://localhost, where cookies work natively and this is a
 * no-op. Install it before anything reads a cookie — the entry does it first.
 */
const STORAGE_KEY = "infrawrench-cookie-jar";

/** True when a written cookie can be read back, i.e. the origin has a jar. */
function cookiesPersist(): boolean {
  const probe = `__iw_probe_${Date.now()}`;
  try {
    document.cookie = `${probe}=1;path=/`;
    const worked = document.cookie.includes(`${probe}=1`);
    if (worked) document.cookie = `${probe}=;path=/;max-age=0`;
    return worked;
  } catch {
    return false;
  }
}

function load(): Map<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Map<string, string>(raw ? Object.entries(JSON.parse(raw) as object) : []);
  } catch {
    return new Map();
  }
}

function save(jar: Map<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(jar)));
  } catch {
    // Storage denied — the jar stays in memory for this session.
  }
}

/**
 * Installs the shim when the origin drops cookies. Returns whether it was
 * needed, which the caller may log; installing twice is a no-op.
 */
export function installCookieStoreShim(): boolean {
  if (typeof document === "undefined" || typeof localStorage === "undefined") return false;
  if (cookiesPersist()) return false;

  const jar = load();

  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set(input: string) {
      // A write is `name=value` followed by optional `; attr[=v]` pairs. Only
      // expiry matters here: gt deletes a cookie with max-age=0 / a past date,
      // and treating that as a normal write would resurrect stale values.
      const [pair, ...attrs] = String(input).split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) return;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();

      const expired = attrs.some((attr) => {
        const [rawKey, rawValue = ""] = attr.split("=");
        const key = rawKey?.trim().toLowerCase();
        if (key === "max-age") return Number(rawValue.trim()) <= 0;
        if (key === "expires") {
          const at = Date.parse(rawValue.trim());
          return !Number.isNaN(at) && at <= Date.now();
        }
        return false;
      });

      if (expired) jar.delete(name);
      else jar.set(name, value);
      save(jar);
    },
  });

  return true;
}
