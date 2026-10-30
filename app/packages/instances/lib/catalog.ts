import { parseName, sizeRank } from "./names";

/** One family on a service's listing page, e.g. `m5`, `db.r5`, `ml.c6g (Hosting)`. */
export interface Family {
  /** Stable id, `familyKey` from `parseName`. */
  key: string;
  /** How the listing names it. */
  label: string;
  /** Instance names, smallest size first. */
  instances: string[];
}

const collator = new Intl.Collator("en", { numeric: true });

/**
 * A service's instance names grouped into families, families in natural order
 * (`c5` before `c5a` before `c6g`, `m5` before `m10`). Names that do not parse
 * as family plus size go last under `Other` (the caller translates that).
 */
export function familiesOf(names: string[]): Family[] {
  const byKey = new Map<string, Family>();
  const other: string[] = [];
  for (const name of names) {
    const p = parseName(name);
    if (!p) {
      other.push(name);
      continue;
    }
    const [before, family, after] = p.familyKey.split("|") as [string, string, string];
    const label = `${before ? `${before}.` : ""}${family}${after ? ` (${after.replace(/^[-.]/, "")})` : ""}`;
    const entry = byKey.get(p.familyKey) ?? { key: p.familyKey, label, instances: [] };
    entry.instances.push(name);
    byKey.set(p.familyKey, entry);
  }
  const bySize = (a: string, b: string) =>
    sizeRank(parseName(a)!.size) - sizeRank(parseName(b)!.size) || collator.compare(a, b);
  const families = [...byKey.values()]
    .map((f) => ({ ...f, instances: f.instances.sort(bySize) }))
    .sort((a, b) => collator.compare(a.label, b.label));
  if (other.length > 0) {
    families.push({ key: "", label: "", instances: other.sort(collator.compare) });
  }
  return families;
}
