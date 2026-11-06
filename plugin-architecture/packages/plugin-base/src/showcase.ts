/**
 * What a resource shows on its tile. A type marks fields with `showcase: true`
 * and each one becomes a row, labelled from the field; one named like a run-state
 * becomes the coloured status line instead. Everything is read from the fields the
 * lister already synced, so drawing a tile never costs a provider API call.
 */
import type { FieldDefinition, ResourceTypeDefinition } from "./resource.js";

/** The part of a marked field a tile needs. An API sends just this. */
export type ShowcaseField = Pick<FieldDefinition, "key" | "label">;

export type ShowcaseTone = "success" | "warning" | "danger" | "neutral";

export interface ShowcaseStat {
  key: string;
  label: string;
  /** The printed value, except for a boolean: `flag` is set and the host translates it. */
  value: string;
  flag?: boolean;
}

export interface ResourceShowcase {
  status?: { key: string; value: string; tone: ShowcaseTone };
  stats: ShowcaseStat[];
}

/** Rows that fit under a two-line name and a status line on a square tile. */
export const SHOWCASE_MAX_STATS = 3;

/** The fields a type marked for its tile. */
export function showcaseFields(type: Pick<ResourceTypeDefinition, "fields">): ShowcaseField[] {
  return type.fields.flatMap((f) => (f.showcase ? [{ key: f.key, label: f.label }] : []));
}

const STATUS_KEY = /^(status|state|phase|health)$|(Status|State|Phase|Health)$/;

const TONES: Record<Exclude<ShowcaseTone, "neutral">, string> = {
  success:
    "active running ready healthy available online enabled ok succeeded success deployed live started up bound attached inuse completed complete verified issued published green normal",
  warning:
    "pending degraded provisioning creating starting stopping updating upgrading rebooting restarting modifying maintenance deploying building queued progressing initializing initialising migrating scaling warning resizing new yellow",
  danger:
    "error errored failed failure unhealthy crashed crashloopbackoff imagepullbackoff down offline critical unavailable red",
};

const TONE_BY_WORD = new Map(
  Object.entries(TONES).flatMap(([tone, words]) =>
    words.split(" ").map((word) => [word, tone as ShowcaseTone] as const),
  ),
);

/** The colour a provider's status word reads as. A word nobody listed stays neutral. */
export function showcaseStatusTone(value: string): ShowcaseTone {
  return TONE_BY_WORD.get(value.toLowerCase().replace(/[^a-z]/g, "")) ?? "neutral";
}

function prettifyStatus(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  const base = spaced === spaced.toUpperCase() ? spaced.toLowerCase() : spaced;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const BYTES_PER: Record<string, number> = { bytes: 1, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** A size's unit, from the key (`memoryMb`) or the label ("Allocated Storage (GiB)"). */
function sizeUnit({ key, label }: ShowcaseField): number | undefined {
  const fromKey = /(bytes|mb|gb|tb)$/i.exec(key)?.[1];
  const fromLabel = /\((bytes|[mgt]i?b)\)$/i.exec(label)?.[1];
  const unit = (fromKey ?? fromLabel)?.toLowerCase().replace("ib", "b");
  return unit ? BYTES_PER[unit] : undefined;
}

function printNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function printBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${printNumber(bytes / 1024 ** i)} ${units[i]}`;
}

const DATE_KEY = /(At|Date|Time|On)$|^created$/;

/** Prints a field by what it holds. `undefined` means it has nothing worth a row. */
function printValue(field: ShowcaseField, raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "object") return undefined;

  const unit = sizeUnit(field);
  if (unit !== undefined) {
    // Listers default a missing size to 0, so a zero here means "unknown".
    const size = Number(raw);
    return size > 0 ? printBytes(size * unit) : undefined;
  }
  if (typeof raw === "number") return printNumber(raw);

  const text = String(raw);
  if (DATE_KEY.test(field.key)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
  }
  // A connection URL shows its host, never its path or embedded credentials.
  if (text.includes("://")) {
    try {
      return new URL(text).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}

/** "Memory (MB)" reads "Memory" once the printed value carries its own unit. */
export function showcaseLabel(label: string): string {
  return label.replace(/\s*[(（](bytes|[mgt]i?b)[)）]$/i, "");
}

/** Turns an instance's synced fields into what its tile shows. */
export function buildResourceShowcase(
  values: Record<string, unknown> | undefined,
  fields: readonly ShowcaseField[] | undefined,
): ResourceShowcase {
  const showcase: ResourceShowcase = { stats: [] };
  for (const field of fields ?? []) {
    const raw = values?.[field.key];
    if (typeof raw === "string" && raw.trim() !== "" && STATUS_KEY.test(field.key)) {
      showcase.status ??= {
        key: field.key,
        value: prettifyStatus(raw),
        tone: showcaseStatusTone(raw),
      };
      continue;
    }
    if (showcase.stats.length >= SHOWCASE_MAX_STATS) continue;
    if (typeof raw === "boolean") {
      showcase.stats.push({ key: field.key, label: field.label, value: String(raw), flag: raw });
      continue;
    }
    const value = printValue(field, raw);
    if (value !== undefined) showcase.stats.push({ key: field.key, label: field.label, value });
  }
  return showcase;
}

/**
 * Drops what a dashboard card's live footer already says, so a pinned resource
 * doesn't show "Memory" twice with two different numbers. The live value wins:
 * synced fields are only as fresh as the last sync.
 */
export function omitLiveShowcaseStats(
  showcase: ResourceShowcase,
  live: ReadonlyArray<{ label: string }> | undefined,
): ResourceShowcase {
  if (!live?.length) return showcase;
  const labels = new Set(live.map((stat) => stat.label.toLowerCase()));
  const stats = showcase.stats.filter(
    (stat) => !labels.has(showcaseLabel(stat.label).toLowerCase()),
  );
  const hasLiveStatus = labels.has("status") || labels.has("state");
  return { ...(showcase.status && !hasLiveStatus ? { status: showcase.status } : {}), stats };
}

/**
 * The subset of an instance's fields its tile reads, so an API can ship tile data
 * for a long child list without shipping every field of every child.
 */
export function pickShowcaseValues(
  values: Record<string, unknown> | undefined,
  fields: readonly ShowcaseField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key } of fields) {
    if (values && key in values) out[key] = values[key];
  }
  return out;
}
