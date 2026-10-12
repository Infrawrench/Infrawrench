/**
 * Compliance status: the wire contract and the pure computation that turns
 * evidence-source results plus the org's per-control decisions into a status
 * per control.
 *
 * The server gathers each source (`web/src/services/compliance/`), then calls
 * {@link computeComplianceControls}; every client only reads the result, so
 * "what makes a control green" is decided in exactly one place and is
 * unit-testable without a database.
 *
 * Three control statuses, and the third is a decision rather than a finding:
 * - `evidence`: at least one mapped source has evidence and none shows a gap.
 * - `gaps`: a mapped source shows a gap, or no mapped source produced any
 *   evidence at all. "We could not look" is a gap, never a pass.
 * - `not-applicable`: the org said so, with a written justification (the
 *   server refuses the setting without one), which is what an auditor asks
 *   for on a statement of applicability.
 */
import type { ComplianceControlDefinition, ComplianceFrameworkDefinition } from "./frameworks";
import { getEvidenceSource, type EvidenceSourceId, type EvidenceSourceKind } from "./sources";

/* ------------------------------------------------------------------ *
 * Evidence-source results
 * ------------------------------------------------------------------ */

/**
 * - `present`: the source produced evidence and found nothing wrong.
 * - `gap`: the source produced evidence showing a problem (see `gaps`).
 * - `no-data`: the source ran and there is nothing to show (no scanner
 *   connected, no drills recorded, recording switched off and never used).
 * - `unavailable`: the source could not be read: the caller lacks its
 *   permission, the read threw, or no evaluator is registered for the id.
 */
export type EvidenceStatus = "present" | "gap" | "no-data" | "unavailable";

export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  present: "Evidence present",
  gap: "Gap found",
  "no-data": "No evidence",
  unavailable: "Unavailable",
};

/** One headline figure a source reports ("Open critical findings: 3"). */
export interface EvidenceMetric {
  key: string;
  label: string;
  /** Null when the figure is unknown, which is printed as such rather than as 0. */
  value: number | string | null;
}

/** What one evidence source said, minus its row-level items. */
export interface EvidenceSourceResult {
  sourceId: EvidenceSourceId;
  label: string;
  kind: EvidenceSourceKind;
  status: EvidenceStatus;
  /** One sentence for the screen and the PDF. */
  summary: string;
  metrics: EvidenceMetric[];
  /** Plain-language gap statements; empty unless `status` is `gap`. */
  gaps: string[];
  /** Rows the evidence pack carries for this source (its CSV/JSON). */
  itemCount: number;
  /** Set when `status` is `unavailable`: why. */
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * Per-control decisions
 * ------------------------------------------------------------------ */

/** Bounds the API enforces on a control setting. */
export const COMPLIANCE_CONTROL_LIMITS = {
  maxJustificationLength: 2000,
  maxNotesLength: 2000,
  maxOwnerLabelLength: 200,
} as const;

/** The org's stored decision about one control. Absent row = applicable, unowned. */
export interface ComplianceControlSetting {
  frameworkId: string;
  controlId: string;
  applicable: boolean;
  /** Required (non-empty) when `applicable` is false. */
  justification: string | null;
  /** A member who owns the control. */
  ownerUserId: string | null;
  /** Free-text owner (a team, an alias) when it is not one member. */
  ownerLabel: string | null;
  notes: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
}

/** Create/update payload for `PUT /compliance/controls/:frameworkId/:controlId`. A full replace. */
export interface ComplianceControlSettingInput {
  applicable: boolean;
  justification?: string | null | undefined;
  ownerUserId?: string | null | undefined;
  ownerLabel?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface ComplianceControlOwner {
  userId: string | null;
  /** Member name, or the free-text label. */
  displayName: string;
  isLabel: boolean;
}

/* ------------------------------------------------------------------ *
 * The response
 * ------------------------------------------------------------------ */

export type ComplianceControlStatus = "evidence" | "gaps" | "not-applicable";

export const COMPLIANCE_CONTROL_STATUS_LABELS: Record<ComplianceControlStatus, string> = {
  evidence: "Evidence present",
  gaps: "Gaps",
  "not-applicable": "Not applicable",
};

export interface ComplianceControlRow {
  id: string;
  title: string;
  group: string;
  sources: EvidenceSourceId[];
  status: ComplianceControlStatus;
  /** Why the control is not `evidence`, one line per reason; empty when it is. */
  reasons: string[];
  /** Mapped sources that produced nothing, listed even when the control passes on another source. */
  missingSources: EvidenceSourceId[];
  applicable: boolean;
  justification: string | null;
  owner: ComplianceControlOwner | null;
  notes: string | null;
  /** When the setting was last changed; null when the org never touched this control. */
  settingUpdatedAt: string | null;
}

export interface ComplianceStatusCounts {
  evidence: number;
  gaps: number;
  notApplicable: number;
  total: number;
  /** Applicable controls with no owner. */
  unowned: number;
}

export interface ComplianceFrameworkSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  scopeNote: string;
  controlCount: number;
}

/** Inclusive civil dates, `YYYY-MM-DD`. */
export interface CompliancePeriod {
  from: string;
  to: string;
}

export interface ComplianceStatusResponse {
  framework: ComplianceFrameworkSummary;
  period: CompliancePeriod;
  controls: ComplianceControlRow[];
  sources: EvidenceSourceResult[];
  counts: ComplianceStatusCounts;
  generatedAt: string;
}

export function toFrameworkSummary(f: ComplianceFrameworkDefinition): ComplianceFrameworkSummary {
  return {
    id: f.id,
    name: f.name,
    version: f.version,
    description: f.description,
    scopeNote: f.scopeNote,
    controlCount: f.controls.length,
  };
}

/* ------------------------------------------------------------------ *
 * The computation
 * ------------------------------------------------------------------ */

function controlRow(
  control: ComplianceControlDefinition,
  results: ReadonlyMap<EvidenceSourceId, EvidenceSourceResult>,
  setting: ComplianceControlSetting | undefined,
  owner: ComplianceControlOwner | null,
): ComplianceControlRow {
  const applicable = setting?.applicable ?? true;
  const base = {
    id: control.id,
    title: control.title,
    group: control.group,
    sources: [...control.sources],
    applicable,
    justification: setting?.justification ?? null,
    owner,
    notes: setting?.notes ?? null,
    settingUpdatedAt: setting?.updatedAt ?? null,
  };

  const missingSources: EvidenceSourceId[] = [];
  const reasons: string[] = [];
  let present = 0;
  for (const sourceId of control.sources) {
    const result = results.get(sourceId);
    const label = result?.label ?? getEvidenceSource(sourceId)?.label ?? sourceId;
    if (!result || result.status === "unavailable") {
      missingSources.push(sourceId);
      continue;
    }
    if (result.status === "no-data") {
      missingSources.push(sourceId);
      continue;
    }
    present++;
    if (result.status === "gap") {
      for (const gap of result.gaps) reasons.push(`${label}: ${gap}`);
      if (result.gaps.length === 0) reasons.push(`${label}: ${result.summary}`);
    }
  }

  if (!applicable) {
    return { ...base, status: "not-applicable", reasons: [], missingSources };
  }
  if (present === 0) {
    const labels = control.sources.map(
      (id) => results.get(id)?.label ?? getEvidenceSource(id)?.label ?? id,
    );
    reasons.push(`No evidence collected from ${labels.join(", ")}`);
  }
  return {
    ...base,
    status: reasons.length > 0 ? "gaps" : "evidence",
    reasons,
    missingSources,
  };
}

export interface ComputeComplianceInput {
  framework: ComplianceFrameworkDefinition;
  results: readonly EvidenceSourceResult[];
  settings: readonly ComplianceControlSetting[];
  /** userId -> display name, for owners that are members. */
  memberNames?: ReadonlyMap<string, string>;
}

/** Status per control, in the framework's own order, plus counts. */
export function computeComplianceControls(input: ComputeComplianceInput): {
  controls: ComplianceControlRow[];
  counts: ComplianceStatusCounts;
} {
  const results = new Map(input.results.map((r) => [r.sourceId, r]));
  const settings = new Map(
    input.settings.filter((s) => s.frameworkId === input.framework.id).map((s) => [s.controlId, s]),
  );
  const controls = input.framework.controls.map((control) => {
    const setting = settings.get(control.id);
    let owner: ComplianceControlOwner | null = null;
    if (setting?.ownerUserId) {
      const name = input.memberNames?.get(setting.ownerUserId);
      // A departed owner reads as such rather than vanishing: an unowned
      // control and a control whose owner left are different conversations.
      owner = { userId: setting.ownerUserId, displayName: name ?? "Former member", isLabel: false };
    } else if (setting?.ownerLabel) {
      owner = { userId: null, displayName: setting.ownerLabel, isLabel: true };
    }
    return controlRow(control, results, setting, owner);
  });
  const counts: ComplianceStatusCounts = {
    evidence: 0,
    gaps: 0,
    notApplicable: 0,
    total: controls.length,
    unowned: 0,
  };
  for (const c of controls) {
    if (c.status === "evidence") counts.evidence++;
    else if (c.status === "gaps") counts.gaps++;
    else counts.notApplicable++;
    if (c.applicable && !c.owner) counts.unowned++;
  }
  return { controls, counts };
}

/**
 * Validate a control setting the way the server does, so editors can grey
 * out Save on exactly what would be rejected. Returns the error or null.
 */
export function validateComplianceControlSetting(
  input: ComplianceControlSettingInput,
): string | null {
  const justification = input.justification?.trim() ?? "";
  if (!input.applicable && justification === "") {
    return "A control marked not applicable needs a justification.";
  }
  if (justification.length > COMPLIANCE_CONTROL_LIMITS.maxJustificationLength) {
    return `The justification can be at most ${COMPLIANCE_CONTROL_LIMITS.maxJustificationLength} characters.`;
  }
  if ((input.notes?.trim() ?? "").length > COMPLIANCE_CONTROL_LIMITS.maxNotesLength) {
    return `Notes can be at most ${COMPLIANCE_CONTROL_LIMITS.maxNotesLength} characters.`;
  }
  const label = input.ownerLabel?.trim() ?? "";
  if (label.length > COMPLIANCE_CONTROL_LIMITS.maxOwnerLabelLength) {
    return `The owner label can be at most ${COMPLIANCE_CONTROL_LIMITS.maxOwnerLabelLength} characters.`;
  }
  if (input.ownerUserId && label !== "") {
    return "Pick a member or type an owner label, not both.";
  }
  return null;
}
