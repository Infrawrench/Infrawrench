/**
 * Countries where analytics storage needs the visitor's consent first: the EEA
 * (the EU plus Iceland, Liechtenstein and Norway) under the ePrivacy Directive,
 * the UK under PECR, and Switzerland under the revFADP. Everyone else gets
 * analytics by default and can still turn it off from the footer.
 */
const CONSENT_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
  "CH",
]);

/**
 * The `loc=` line of Cloudflare's `/cdn-cgi/trace` response: the visitor's
 * country as Cloudflare geolocates their IP, the same value as the
 * `CF-IPCountry` request header.
 */
export function parseTraceCountry(body: string): string | null {
  for (const line of body.split("\n")) {
    if (line.startsWith("loc=")) {
      const code = line.slice(4).trim().toUpperCase();
      return /^[A-Z0-9]{2}$/.test(code) ? code : null;
    }
  }
  return null;
}

/**
 * Whether a country needs the consent prompt. Unknown answers do too:
 * Cloudflare reports `XX` when it cannot place an IP and `T1` for Tor, and
 * neither says the visitor is outside the EEA.
 */
export function countryNeedsConsent(country: string | null): boolean {
  if (!country || country === "XX" || country === "T1") return true;
  return CONSENT_COUNTRIES.has(country);
}

/**
 * Asks Cloudflare where the visitor is. Every surface this runs on is served
 * through Cloudflare, which answers `/cdn-cgi/trace` on any proxied hostname
 * before the Worker sees the request, so no site needs a geo endpoint of its
 * own (and a cached page cannot carry a per-visitor answer in its HTML).
 *
 * Any failure means "ask": local dev has no `/cdn-cgi/`, and a lookup that
 * cannot answer must not be read as permission.
 */
export async function visitorNeedsConsent(): Promise<boolean> {
  try {
    const res = await fetch("/cdn-cgi/trace", {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return true;
    return countryNeedsConsent(parseTraceCountry(await res.text()));
  } catch {
    return true;
  }
}
