// Pure presentation for `infrawrench compliance`. Kept out of the command
// module (which reaches the network through `./context`, and with it Electron
// and every plugin) so the flag validation and the formatting can be
// unit-tested directly. Imports nothing but `./output`.
//
// The statuses and labels are re-derived here rather than imported from
// client-core: the CLI's client-core imports are type-only at module scope
// (the main project is CJS, the package ESM), and an unknown status from a
// newer server must still render rather than crash.
import { c, safe } from "./output";

/** The framework a bare `infrawrench compliance` reports on. */
export const DEFAULT_COMPLIANCE_FRAMEWORK = "soc2";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `--framework`, lowercased and trimmed, defaulting to SOC 2. The server owns
 * the list of frameworks (`compliance frameworks`), so an unknown id is
 * reported by the API rather than guessed at here; this only refuses
 * something that cannot be an id at all.
 */
export function parseComplianceFrameworkFlag(raw: string | undefined): string | { error: string } {
  if (raw === undefined) return DEFAULT_COMPLIANCE_FRAMEWORK;
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return { error: `--framework takes a framework id such as soc2 or iso27001 (got "${raw}").` };
  }
  return id;
}

/**
 * `--from` / `--to` as a compliance period: civil dates, both optional (the
 * server fills the default 90 days, and a lone `--to` means the 90 days ending
 * then). A malformed or inverted value is an error before any request, because
 * the period is printed on every page of the pack.
 */
export function parseCompliancePeriodFlags(
  from: string | undefined,
  to: string | undefined,
): { from?: string; to?: string } | { error: string } {
  const out: { from?: string; to?: string } = {};
  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value === undefined || value === "") continue;
    const v = value.trim();
    if (!ISO_DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
      return { error: `--${name} must be a date (YYYY-MM-DD), got "${value}".` };
    }
    out[name] = v;
  }
  if (out.from && out.to && out.from > out.to) {
    return { error: "--from must be on or before --to." };
  }
  return out;
}

/** The `framework=…&from=…&to=…` query, the same one client-core's `complianceQuery` builds. */
export function complianceQueryString(
  frameworkId: string,
  period: { from?: string | undefined; to?: string | undefined },
): string {
  const query = new URLSearchParams({ framework: frameworkId });
  if (period.from) query.set("from", period.from);
  if (period.to) query.set("to", period.to);
  return query.toString();
}

/** The evidence pack's file name, client-core's `evidencePackFileName` re-derived. */
export function compliancePackFileName(
  frameworkId: string,
  period: { from: string; to: string },
): string {
  const id = frameworkId.replace(/[^a-z0-9_-]/gi, "") || "compliance";
  return `${id}-evidence-${period.from}-to-${period.to}.zip`;
}

/**
 * The file name a `Content-Disposition` header names, when it names one we
 * can safely write: no directories, no control characters. Null otherwise.
 */
export function fileNameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  let name: string | null = null;
  if (star?.[1]) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/.exec(header);
    name = plain?.[1] ?? plain?.[2] ?? null;
  }
  if (!name) return null;
  const base = safe(name).split(/[\\/]/).pop()!.trim();
  return base && base !== "." && base !== ".." ? base : null;
}

const CONTROL_STATUS_WORD: Record<string, string> = {
  evidence: "evidence",
  gaps: "gaps",
  "not-applicable": "n/a",
};

/** A control's status as one coloured word: green evidence, red gaps, dim n/a. */
export function formatControlStatus(status: string): string {
  const word = CONTROL_STATUS_WORD[status] ?? safe(status);
  if (status === "evidence") return c.green(word);
  if (status === "gaps") return c.red(word);
  return c.dim(word);
}

const EVIDENCE_STATUS_WORD: Record<string, string> = {
  present: "present",
  gap: "gap",
  "no-data": "no data",
  unavailable: "unavailable",
};

/** An evidence source's status: green present, red gap, yellow unavailable, dim no data. */
export function formatEvidenceStatus(status: string): string {
  const word = EVIDENCE_STATUS_WORD[status] ?? safe(status);
  if (status === "present") return c.green(word);
  if (status === "gap") return c.red(word);
  if (status === "unavailable") return c.yellow(word);
  return c.dim(word);
}

/** The control's owner, sanitised (org-controlled text), or a dim "unowned". */
export function formatControlOwner(
  owner: { displayName: string } | null | undefined,
  applicable = true,
): string {
  const name = safe(owner?.displayName).trim();
  if (name) return name;
  return applicable ? c.yellow("unowned") : c.dim("unowned");
}

/** Truncate to `max` visible characters with a trailing ellipsis. */
export function truncateText(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "9 with evidence · 5 with gaps · 2 not applicable · 3 unowned", colours on. */
export function formatComplianceCounts(counts: {
  evidence: number;
  gaps: number;
  notApplicable: number;
  total: number;
  unowned: number;
}): string {
  const parts = [
    c.green(`${counts.evidence} with evidence`),
    counts.gaps > 0 ? c.red(`${counts.gaps} with gaps`) : c.dim("0 with gaps"),
  ];
  if (counts.notApplicable > 0) parts.push(c.dim(`${counts.notApplicable} not applicable`));
  if (counts.unowned > 0) parts.push(c.yellow(`${counts.unowned} unowned`));
  return `${parts.join(c.dim(" · "))} ${c.dim(`(of ${counts.total})`)}`;
}

/** "SOC 2 (2017 TSC) · 2026-07-01 to 2026-09-30 (92 days)". */
export function formatComplianceHeader(
  framework: { name: string; version: string },
  period: { from: string; to: string },
): string {
  const days =
    Math.round(
      (Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  const version = safe(framework.version).trim();
  const span = Number.isFinite(days) && days > 0 ? ` (${days} day${days === 1 ? "" : "s"})` : "";
  return `${c.bold(safe(framework.name))}${version ? ` ${c.dim(version)}` : ""} ${c.dim(
    `· ${period.from} to ${period.to}${span}`,
  )}`;
}
