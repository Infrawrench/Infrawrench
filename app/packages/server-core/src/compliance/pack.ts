/**
 * Evidence pack assembly: a ZIP holding a PDF summary, `controls.csv` and
 * `controls.json`, one CSV and JSON per control, one CSV and JSON per
 * evidence source, `manifest.json` listing every other file with its SHA-256,
 * and `SHA256SUMS` carrying the manifest's own digest (a file cannot list its
 * own hash).
 *
 * The bytes are built from one `collectComplianceEvidence` call, so the PDF,
 * the CSVs and the manifest counts can never disagree with each other. The
 * download route and the scheduled delivery both call {@link buildEvidencePack}.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  COMPLIANCE_CONTROL_STATUS_LABELS,
  EVIDENCE_PACK_FORMAT,
  EVIDENCE_PACK_FORMAT_VERSION,
  EVIDENCE_STATUS_LABELS,
  evidencePackFileName,
  getEvidenceSource,
  toComplianceCsv,
  type ComplianceControlRow,
  type CompliancePeriod,
  type ComplianceStatusResponse,
  type EvidencePackFile,
  type EvidencePackManifest,
  type EvidenceSourceResult,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { organizations } from "../db/schema";
import { orgAppUrl } from "../app-url";
import { renderReportPdf, type PdfSection } from "../pdf";
import { collectComplianceEvidence, type ComplianceStatusOptions } from "./status";
import { buildZip, type ZipEntry } from "./zip";

export interface EvidencePack {
  filename: string;
  bytes: Uint8Array;
  manifest: EvidencePackManifest;
  status: ComplianceStatusResponse;
  /** The PDF on its own, for transports that want just the summary. */
  pdf: Uint8Array;
}

export interface BuildEvidencePackOptions extends ComplianceStatusOptions {
  /** A member's name, or `Scheduled delivery`. */
  generatedBy: string;
  /** IANA zone for the PDF's generated-at line. */
  timezone?: string;
}

const encoder = new TextEncoder();

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A path segment safe in every unzip tool: the control id with anything odd replaced. */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function metricValue(v: number | string | null): string {
  return v === null ? "unknown" : String(v);
}

function controlCsv(control: ComplianceControlRow, results: Map<string, EvidenceSourceResult>): string {
  const rows: (string | number | null)[][] = [];
  for (const sourceId of control.sources) {
    const r = results.get(sourceId);
    const label = r?.label ?? getEvidenceSource(sourceId)?.label ?? sourceId;
    const status = r ? EVIDENCE_STATUS_LABELS[r.status] : "Unavailable";
    rows.push([control.id, control.title, COMPLIANCE_CONTROL_STATUS_LABELS[control.status], label, status, "summary", r?.summary ?? null]);
    for (const metric of r?.metrics ?? []) {
      rows.push([control.id, control.title, COMPLIANCE_CONTROL_STATUS_LABELS[control.status], label, status, metric.label, metricValue(metric.value)]);
    }
    for (const gap of r?.gaps ?? []) {
      rows.push([control.id, control.title, COMPLIANCE_CONTROL_STATUS_LABELS[control.status], label, status, "gap", gap]);
    }
  }
  return toComplianceCsv(["Control", "Title", "Control status", "Evidence source", "Source status", "Item", "Value"], rows);
}

function controlsCsv(controls: readonly ComplianceControlRow[]): string {
  return toComplianceCsv(
    ["Control", "Title", "Group", "Status", "Applicable", "Justification", "Owner", "Evidence sources", "Missing sources", "Reasons", "Notes"],
    controls.map((c) => [
      c.id,
      c.title,
      c.group,
      COMPLIANCE_CONTROL_STATUS_LABELS[c.status],
      c.applicable ? "yes" : "no",
      c.justification,
      c.owner?.displayName ?? null,
      c.sources.join(", "),
      c.missingSources.join(", "),
      c.reasons.join(" | "),
      c.notes,
    ]),
  );
}

function pdfSections(status: ComplianceStatusResponse): PdfSection[] {
  const sections: PdfSection[] = [
    {
      title: "Summary",
      subtitle: `${status.framework.name}, ${status.framework.version}`,
      blocks: [
        {
          kind: "stats",
          items: [
            { label: "Evidence present", value: String(status.counts.evidence), tone: "good" },
            { label: "Gaps", value: String(status.counts.gaps), tone: status.counts.gaps > 0 ? "bad" : "default" },
            { label: "Not applicable", value: String(status.counts.notApplicable) },
            { label: "Without an owner", value: String(status.counts.unowned), tone: status.counts.unowned > 0 ? "bad" : "default" },
          ],
        },
        { kind: "text", text: status.framework.scopeNote, tone: "muted" },
      ],
    },
    {
      title: "Controls",
      blocks: [
        {
          kind: "table",
          columns: ["Control", "Title", "Status", "Owner"],
          rows: status.controls.map((c) => [
            c.id,
            c.title,
            COMPLIANCE_CONTROL_STATUS_LABELS[c.status],
            c.owner?.displayName ?? "Unowned",
          ]),
        },
      ],
    },
  ];

  const attention = status.controls.filter((c) => c.status !== "evidence");
  for (const c of attention) {
    sections.push({
      title: `${c.id} ${c.title}`,
      subtitle: COMPLIANCE_CONTROL_STATUS_LABELS[c.status],
      blocks: [
        ...(c.status === "not-applicable"
          ? [{ kind: "text" as const, text: `Justification: ${c.justification ?? ""}` }]
          : c.reasons.map((r) => ({ kind: "text" as const, text: r, tone: "danger" as const }))),
      ],
    });
  }

  for (const s of status.sources) {
    sections.push({
      title: s.label,
      subtitle: `${EVIDENCE_STATUS_LABELS[s.status]} · ${s.kind === "snapshot" ? "as of generation time" : "during the period"}`,
      blocks: [
        { kind: "text", text: s.summary, ...(s.status === "unavailable" ? { tone: "muted" as const } : {}) },
        ...(s.metrics.length > 0
          ? [
              {
                kind: "table" as const,
                columns: ["Measure", "Value"],
                rows: s.metrics.map((metric) => [metric.label, metricValue(metric.value)]),
                align: ["left", "right"] as Array<"left" | "right">,
              },
            ]
          : []),
        ...s.gaps.map((g) => ({ kind: "text" as const, text: g, tone: "danger" as const })),
      ],
    });
  }
  return sections;
}

export async function buildEvidencePack(
  organizationId: string,
  frameworkId: string,
  opts: BuildEvidencePackOptions,
): Promise<EvidencePack> {
  const now = opts.now ?? new Date();
  const bundle = await collectComplianceEvidence(organizationId, frameworkId, { ...opts, now });
  const { status, framework, collections } = bundle;
  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const orgName = org?.displayName ?? organizationId;

  const pdf = renderReportPdf({
    title: `${framework.name} evidence pack`,
    subtitle: `Period ${status.period.from} to ${status.period.to}`,
    orgName,
    url: orgAppUrl(organizationId, "compliance"),
    notes: [
      `Generated by ${opts.generatedBy}. Posture, access review, vulnerability and backup coverage figures describe the organization at generation time; period sources cover only the dates above.`,
    ],
    sections: pdfSections(status),
    generatedAt: now,
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
  });

  const results = new Map(status.sources.map((s) => [s.sourceId, s]));
  const files: Array<ZipEntry & { description: string }> = [
    { path: "summary.pdf", data: pdf, description: "Printable summary of every control and evidence source" },
    { path: "controls.csv", data: encoder.encode(controlsCsv(status.controls)), description: "One row per control: status, owner, applicability" },
    { path: "controls.json", data: encoder.encode(JSON.stringify(status, null, 2)), description: "The full status as returned by the API" },
  ];
  for (const control of status.controls) {
    const seg = safeSegment(control.id);
    files.push({
      path: `controls/${seg}.csv`,
      data: encoder.encode(controlCsv(control, results)),
      description: `Control ${control.id}: evidence per source`,
    });
    files.push({
      path: `controls/${seg}.json`,
      data: encoder.encode(
        JSON.stringify({ control, evidence: control.sources.map((id) => results.get(id) ?? null) }, null, 2),
      ),
      description: `Control ${control.id} as JSON`,
    });
  }
  for (const [sourceId, collection] of collections) {
    if (collection.csv !== null) {
      files.push({
        path: `evidence/${safeSegment(sourceId)}.csv`,
        data: encoder.encode(collection.csv),
        description: `${collection.result.label}: rows`,
      });
    }
    files.push({
      path: `evidence/${safeSegment(sourceId)}.json`,
      data: encoder.encode(JSON.stringify({ result: collection.result, evidence: collection.json }, null, 2)),
      description: `${collection.result.label}: full evidence`,
    });
  }

  const manifestFiles: EvidencePackFile[] = files.map((f) => ({
    path: f.path,
    sha256: sha256(f.data),
    bytes: f.data.length,
    description: f.description,
  }));
  const manifest: EvidencePackManifest = {
    format: EVIDENCE_PACK_FORMAT,
    formatVersion: EVIDENCE_PACK_FORMAT_VERSION,
    organization: { id: organizationId, name: orgName },
    framework: { id: framework.id, name: framework.name, version: framework.version },
    period: status.period,
    generatedAt: now.toISOString(),
    generatedBy: opts.generatedBy,
    counts: status.counts,
    snapshotSources: status.sources.filter((s) => s.kind === "snapshot").map((s) => s.sourceId),
    files: manifestFiles,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  const sums = encoder.encode(
    [`${sha256(manifestBytes)}  manifest.json`, ...manifestFiles.map((f) => `${f.sha256}  ${f.path}`)].join("\n") + "\n",
  );

  const bytes = buildZip(
    [
      { path: "manifest.json", data: manifestBytes },
      { path: "SHA256SUMS", data: sums },
      ...files.map(({ path, data }) => ({ path, data })),
    ],
    now,
  );
  return {
    filename: evidencePackFileName(framework.id, status.period),
    bytes,
    manifest,
    status,
    pdf,
  };
}

export type { CompliancePeriod };
