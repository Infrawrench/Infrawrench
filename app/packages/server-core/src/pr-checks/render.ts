/**
 * Render a pull request check report as GitHub Markdown: the check run's
 * output (title, summary, annotations) and the sticky comment's body. Pure.
 *
 * GitHub caps a check run's `summary` and `text` at 65535 characters each and
 * accepts at most 50 annotations per request; every renderer here stays
 * under those so an enormous pull request degrades to a truncated table, not
 * a rejected update.
 */
import {
  PR_CHECK_COMMENT_MARKER,
  formatMonthlyDelta,
  formatMonthlyEstimate,
  prCheckTitle,
  type PrCheckChange,
  type PrCheckConclusion,
  type PrCheckReport,
} from "@infrawrench/client-core";

import type { GithubCheckRunAnnotation, GithubCheckRunOutput } from "../github/issues-api.js";

export const GITHUB_SUMMARY_LIMIT = 65_535;
export const GITHUB_ANNOTATION_LIMIT = 50;
/** Rows in the changes table before the rest are counted, not listed. */
const MAX_TABLE_ROWS = 60;

export interface RenderLinks {
  /** The org's IaC page, or null without `APP_URL`. */
  iacUrl: string | null;
  /** Deep link to one matched resource, or null without `APP_URL`. */
  resourceUrl: (change: PrCheckChange) => string | null;
}

/** Escape a value for a Markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function money(amount: number, currency: string, partial: boolean): string {
  return `${formatMonthlyEstimate(amount, currency)}${partial ? "+" : ""}`;
}

const ACTION_LABEL: Record<PrCheckChange["action"], string> = {
  create: "add",
  update: "change",
  delete: "remove",
};

function deltaCell(c: PrCheckChange): string {
  if (c.monthlyDelta !== null && c.currency) {
    return `**${formatMonthlyDelta(c.monthlyDelta, c.currency)}**${c.count !== null && c.count !== 1 ? ` (×${c.count})` : ""}`;
  }
  return "not priced";
}

function sideCell(c: PrCheckChange, which: "before" | "after"): string {
  const s = c[which];
  if (s) return money(s.monthlyAmount, s.currency, s.partial);
  if (
    (which === "before" && c.action === "create") ||
    (which === "after" && c.action === "delete")
  ) {
    return "-";
  }
  return "?";
}

function blastCell(c: PrCheckChange): string {
  if (c.action === "create") return "new";
  if (!c.resourceId) return "not matched";
  const b = c.blastRadius;
  if (!b) return "unknown";
  const total = b.directDependants + b.transitiveDependants;
  const parts = [`${total} dependant${total === 1 ? "" : "s"}`];
  if (b.references > 0) parts.push(`${b.references} reference${b.references === 1 ? "" : "s"}`);
  return `${b.severity}: ${parts.join(", ")}`;
}

function resourceCell(c: PrCheckChange, links: RenderLinks): string {
  const address = `\`${cell(c.address)}\``;
  if (!c.resourceId || !c.displayName) return address;
  const url = links.resourceUrl(c);
  const name = cell(c.displayName);
  return url ? `${address} ([${name}](${url}))` : `${address} (${name})`;
}

function headline(report: PrCheckReport): string {
  const t = report.totals;
  if (report.files.length === 0) return "This pull request changes no infrastructure files.";
  if (report.changes.length === 0) {
    return "Infrastructure files changed, but no Terraform resource block did.";
  }
  const parts: string[] = [];
  if (t.monthlyDelta !== null && t.currency) {
    const floor = t.partial && t.monthlyDelta > 0 ? "at least " : "";
    parts.push(
      `Estimated monthly cost change: **${floor}${formatMonthlyDelta(t.monthlyDelta, t.currency)}**`,
    );
  } else {
    parts.push("Estimated monthly cost change: **unknown** (nothing could be priced)");
  }
  if (t.unpricedChanges > 0) {
    parts.push(`${t.unpricedChanges} change${t.unpricedChanges === 1 ? "" : "s"} not priced`);
  }
  if (report.blast.touchedResources > 0) {
    parts.push(
      `${report.blast.touchedResources} existing resource${report.blast.touchedResources === 1 ? "" : "s"} touched, ${report.blast.dependants} dependant${report.blast.dependants === 1 ? "" : "s"} downstream`,
    );
  }
  return `${parts.join(" · ")}.`;
}

/** The Markdown body shared by the check summary and the comment. */
export function renderReportMarkdown(report: PrCheckReport, links: RenderLinks): string {
  const lines: string[] = [headline(report), ""];

  if (report.changes.length > 0) {
    lines.push("| Resource | Action | Before | After | Monthly change | Blast radius |");
    lines.push("| --- | --- | ---: | ---: | ---: | --- |");
    for (const c of report.changes.slice(0, MAX_TABLE_ROWS)) {
      lines.push(
        `| ${resourceCell(c, links)} | ${ACTION_LABEL[c.action]} | ${sideCell(c, "before")} | ${sideCell(c, "after")} | ${deltaCell(c)} | ${cell(blastCell(c))} |`,
      );
    }
    if (report.changes.length > MAX_TABLE_ROWS) {
      lines.push("", `…and ${report.changes.length - MAX_TABLE_ROWS} more changes.`);
    }
    lines.push("");
  }

  const risky = report.changes.filter(
    (c) =>
      c.blastRadius && (c.blastRadius.severity === "high" || c.blastRadius.severity === "medium"),
  );
  if (risky.length > 0) {
    lines.push("### Blast radius", "");
    for (const c of risky.slice(0, 15)) {
      const b = c.blastRadius!;
      const top =
        b.topDependants.length > 0 ? ` Directly: ${b.topDependants.map(cell).join(", ")}.` : "";
      lines.push(`- \`${c.address}\` (${ACTION_LABEL[c.action]}): ${b.headline}${top}`);
    }
    lines.push("");
  }

  const warned = report.changes.filter((c) => c.warnings.length > 0);
  if (warned.length > 0) {
    lines.push("### Warnings", "");
    for (const c of warned.slice(0, 30)) {
      for (const w of c.warnings) {
        lines.push(`- ${w.severity === "warning" ? "⚠️" : "ℹ️"} \`${c.address}\`: ${w.message}`);
      }
    }
    lines.push("");
  }

  const unpriced = report.changes.filter((c) => c.unpricedReason);
  if (unpriced.length > 0) {
    lines.push("<details><summary>Why some changes are not priced</summary>", "");
    for (const c of unpriced.slice(0, 30)) lines.push(`- \`${c.address}\`: ${c.unpricedReason}`);
    lines.push("", "</details>", "");
  }

  const skipped = report.files.filter((f) => !f.analysed);
  if (skipped.length > 0) {
    lines.push("<details><summary>Files recognised but not analysed</summary>", "");
    for (const f of skipped.slice(0, 30)) lines.push(`- \`${f.path}\`: ${f.note ?? ""}`);
    lines.push("", "</details>", "");
  }

  if (report.notes.length > 0) {
    lines.push("**Notes**", "");
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push(
    "<sub>Estimates use each provider's list prices for the literal values in the code; " +
      "variables, modules and usage-based charges are not included." +
      (links.iacUrl ? ` [Open in Infrawrench](${links.iacUrl})` : "") +
      "</sub>",
  );

  return clamp(lines.join("\n"));
}

function clamp(text: string): string {
  if (text.length <= GITHUB_SUMMARY_LIMIT) return text;
  const tail = "\n\n…truncated.";
  return text.slice(0, GITHUB_SUMMARY_LIMIT - tail.length) + tail;
}

/** Inline annotations: one per change with a priced delta or a warning. */
export function renderAnnotations(report: PrCheckReport): GithubCheckRunAnnotation[] {
  const out: GithubCheckRunAnnotation[] = [];
  for (const c of report.changes) {
    if (c.line === null || c.action === "delete") continue;
    const messages: string[] = [];
    if (c.monthlyDelta !== null && c.currency && c.monthlyDelta !== 0) {
      messages.push(`Estimated ${formatMonthlyDelta(c.monthlyDelta, c.currency)}/month.`);
    }
    for (const w of c.warnings) messages.push(w.message);
    if (
      c.blastRadius &&
      (c.blastRadius.severity === "high" || c.blastRadius.severity === "medium")
    ) {
      messages.push(c.blastRadius.headline);
    }
    if (messages.length === 0) continue;
    out.push({
      path: c.path,
      start_line: c.line,
      end_line: c.line,
      annotation_level: c.warnings.some((w) => w.severity === "warning") ? "warning" : "notice",
      title: c.address.slice(0, 255),
      message: messages.join("\n"),
    });
    if (out.length >= GITHUB_ANNOTATION_LIMIT) break;
  }
  return out;
}

/** The check run's output object. */
export function renderCheckOutput(report: PrCheckReport, links: RenderLinks): GithubCheckRunOutput {
  return {
    title: prCheckTitle(report),
    summary: renderReportMarkdown(report, links),
    annotations: renderAnnotations(report),
  };
}

const CONCLUSION_LINE: Record<PrCheckConclusion, string> = {
  success: "",
  neutral: "> The monthly cost increase is above this repository's threshold.\n\n",
  failure: "> ❌ The monthly cost increase is above this repository's threshold.\n\n",
};

/** The sticky comment's body: the marker, a heading, then the same report. */
export function renderComment(
  report: PrCheckReport,
  conclusion: PrCheckConclusion,
  links: RenderLinks,
  headSha: string,
): string {
  return clamp(
    `${PR_CHECK_COMMENT_MARKER}\n### Infrawrench: cost and blast radius\n\n${CONCLUSION_LINE[conclusion]}${renderReportMarkdown(report, links)}\n\n<sub>Updated for ${headSha.slice(0, 7)}.</sub>`,
  );
}
