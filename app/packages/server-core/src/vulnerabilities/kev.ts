/**
 * The CISA Known Exploited Vulnerabilities catalog, mirrored into
 * `kev_vulnerabilities` from CISA's public JSON feed.
 *
 * Feed: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
 * (documented at https://www.cisa.gov/known-exploited-vulnerabilities-catalog).
 * Shape: `{ catalogVersion, dateReleased, count, vulnerabilities: [{ cveID,
 * vendorProject, product, vulnerabilityName, dateAdded, dueDate,
 * knownRansomwareCampaignUse: "Known" | "Unknown", ... }] }`. Free, no key,
 * about 1,700 entries, so a whole-catalog upsert twice a day is cheap.
 *
 * Edge-safe: one fixed HTTPS fetch and Postgres, no plugin code.
 */
import { sql } from "drizzle-orm";
import type { VulnerabilityKevEntry } from "@infrawrench/client-core";
import { db } from "../db/client";
import { kevVulnerabilities } from "../db/schema";

export const KEV_FEED_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/** How often the pass refreshes the catalog. CISA adds entries a few times a week. */
export const KEV_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface KevFeedEntry {
  cveID?: unknown;
  vendorProject?: unknown;
  product?: unknown;
  vulnerabilityName?: unknown;
  dateAdded?: unknown;
  dueDate?: unknown;
  knownRansomwareCampaignUse?: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CVE = /^CVE-\d{4}-\d{4,}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Parse the feed into rows, dropping anything malformed rather than failing the batch. */
export function parseKevFeed(body: unknown): Array<typeof kevVulnerabilities.$inferInsert> {
  const list = (body as { vulnerabilities?: unknown } | null)?.vulnerabilities;
  if (!Array.isArray(list)) throw new Error("KEV feed has no vulnerabilities array");
  const out: Array<typeof kevVulnerabilities.$inferInsert> = [];
  const seen = new Set<string>();
  for (const raw of list as KevFeedEntry[]) {
    const cveId = str(raw.cveID)?.toUpperCase();
    const dateAdded = str(raw.dateAdded);
    if (!cveId || !CVE.test(cveId) || !dateAdded || !DATE.test(dateAdded) || seen.has(cveId))
      continue;
    seen.add(cveId);
    const due = str(raw.dueDate);
    out.push({
      cveId,
      vendorProject: str(raw.vendorProject),
      product: str(raw.product),
      name: str(raw.vulnerabilityName),
      dateAdded,
      dueDate: due && DATE.test(due) ? due : null,
      knownRansomware: str(raw.knownRansomwareCampaignUse)?.toLowerCase() === "known",
    });
  }
  return out;
}

/** Fetch the catalog and upsert it. Returns the number of entries written. */
export async function refreshKevCatalog(fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(KEV_FEED_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`KEV feed returned HTTP ${res.status}`);
  const rows = parseKevFeed(await res.json());
  // A feed that suddenly parses to nothing is a format change, not CISA
  // emptying the catalog; keep what we have.
  if (rows.length === 0) throw new Error("KEV feed parsed to zero entries");
  const now = new Date();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, updatedAt: now }));
    await db
      .insert(kevVulnerabilities)
      .values(chunk)
      .onConflictDoUpdate({
        target: kevVulnerabilities.cveId,
        set: {
          vendorProject: sql`excluded.vendor_project`,
          product: sql`excluded.product`,
          name: sql`excluded.name`,
          dateAdded: sql`excluded.date_added`,
          dueDate: sql`excluded.due_date`,
          knownRansomware: sql`excluded.known_ransomware`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  return rows.length;
}

/** The catalog as a lookup, plus when it was last refreshed. */
export async function loadKevCatalog(): Promise<{
  entries: Map<string, VulnerabilityKevEntry>;
  updatedAt: string | null;
}> {
  const rows = await db
    .select({
      cveId: kevVulnerabilities.cveId,
      dateAdded: kevVulnerabilities.dateAdded,
      dueDate: kevVulnerabilities.dueDate,
      knownRansomware: kevVulnerabilities.knownRansomware,
      updatedAt: kevVulnerabilities.updatedAt,
    })
    .from(kevVulnerabilities);
  let latest: Date | null = null;
  const entries = new Map<string, VulnerabilityKevEntry>();
  for (const r of rows) {
    entries.set(r.cveId, {
      dateAdded: r.dateAdded,
      dueDate: r.dueDate,
      knownRansomware: r.knownRansomware,
    });
    if (!latest || r.updatedAt > latest) latest = r.updatedAt;
  }
  return { entries, updatedAt: latest?.toISOString() ?? null };
}

/** The poller pass body. */
export async function runKevFeedPass(): Promise<void> {
  const count = await refreshKevCatalog();
  console.log(`[vulnerabilities] KEV catalog refreshed: ${count} entries`);
}
