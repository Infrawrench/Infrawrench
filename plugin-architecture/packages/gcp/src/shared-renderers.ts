/**
 * Shared formatting / parsing helpers used by multiple GCP detail renderers.
 *
 * These were originally inline in `detail-renderers.ts`; extracted so each
 * per-service renderer module (e.g. `cloud-run-detail-renderers.ts`,
 * `firestore-detail-renderers.ts`) can import what it needs without pulling
 * in the whole dispatcher.
 */

interface BigQuerySchemaField {
  name?: unknown;
  type?: unknown;
  mode?: unknown;
  description?: unknown;
  fields?: unknown;
}

/**
 * Heuristic: is the given error message about missing IAM permissions?
 * Used to decide whether to show the "grant role X to the SA" advisory.
 */
export function isPermissionError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("permission") ||
    lower.includes("caller does not have") ||
    lower.includes("forbidden") ||
    lower.includes("access denied")
  );
}

/**
 * Truncate a container image reference for table display. Keeps the registry
 * + repo path and shortens any sha256 digest to the first 12 characters.
 */
export function shortImage(image: string): string {
  if (!image) return "—";
  const at = image.indexOf("@sha256:");
  if (at < 0) return image;
  const digest = image.slice(at + "@sha256:".length).slice(0, 12);
  return `${image.slice(0, at)}@${digest}`;
}

/** Format a bytes count (string from the API or number) as e.g. "42.3 MB". */
export function formatBackupSize(bytes: string | number): string {
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i] ?? "B"}`;
}

/** Format an ISO timestamp as a relative "5 min ago" / "2 days ago" string. */
export function formatRelativeTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Turn a protobuf Duration string like "604800s" into "7 days". */
export function formatPitrRetention(duration: string): string {
  const m = /^(\d+)s$/.exec(duration);
  if (!m) return duration || "—";
  const secs = Number(m[1]);
  if (!Number.isFinite(secs)) return duration;
  const days = secs / 86400;
  if (days >= 1) return `${days.toFixed(days === Math.floor(days) ? 0 : 1)} days`;
  const hours = secs / 3600;
  return `${hours.toFixed(hours === Math.floor(hours) ? 0 : 1)} hours`;
}

/**
 * Parse a BigQuery schema JSON blob into flat rows with depth markers for
 * RECORD/STRUCT nesting. Returns [] for unparseable input.
 */
export function bigQuerySchemaToRows(
  schemaJson: string,
): Array<{ cells: Record<string, string>; depth?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: Array<{ cells: Record<string, string>; depth?: number }> = [];
  const walk = (fields: unknown[], depth: number) => {
    for (const raw of fields) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as BigQuerySchemaField;
      const type = typeof f.type === "string" ? f.type : "";
      const mode = typeof f.mode === "string" ? f.mode : "NULLABLE";
      rows.push({
        cells: {
          name: typeof f.name === "string" ? f.name : "",
          type,
          mode,
          description: typeof f.description === "string" ? f.description : "",
        },
        depth,
      });
      if ((type === "RECORD" || type === "STRUCT") && Array.isArray(f.fields)) {
        walk(f.fields, depth + 1);
      }
    }
  };
  walk(parsed, 0);
  return rows;
}
