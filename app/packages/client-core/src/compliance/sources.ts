/**
 * The evidence-source registry: one entry per kind of evidence Infrawrench
 * already collects, and the only vocabulary a framework file may map a
 * control onto.
 *
 * A source here is metadata (id, label, what it proves, whether it is a
 * point-in-time snapshot or a period log, which permission reads it). The
 * code that actually gathers it lives on the server, in
 * `web/src/services/compliance/sources/`, keyed by the same id; a source
 * without an evaluator reports `unavailable`, never a fabricated "present".
 *
 * Adding a source is three edits: an entry here, an evaluator on the server,
 * and the control mappings in whichever framework files it supports. That is
 * the extension point later features plug into (a service scorecard source, a
 * leaked-credential source), deliberately without touching the frameworks'
 * control lists or the status computation.
 */

/** Stable id of an evidence source. Open-ended so integration can add more. */
export type EvidenceSourceId = string;

/** The sources shipped today. A framework mapping naming anything else fails its test. */
export const BUILTIN_EVIDENCE_SOURCE_IDS = [
  "access-review",
  "jit-access",
  "audit-log",
  "posture",
  "vulnerabilities",
  "backup-coverage",
  "restore-drills",
  "change-timeline",
  "change-freezes",
  "session-recordings",
  "incidents",
] as const;
export type BuiltinEvidenceSourceId = (typeof BUILTIN_EVIDENCE_SOURCE_IDS)[number];

/**
 * `snapshot`: describes the org as it stands at generation time (posture,
 * open vulnerabilities, backup coverage). The period does not filter it, and
 * the pack says so rather than implying it was true on every day of the
 * period. `period`: a log of things that happened, filtered to the period.
 */
export type EvidenceSourceKind = "snapshot" | "period";

export interface EvidenceSourceDefinition {
  id: EvidenceSourceId;
  label: string;
  /** One sentence: what this evidence demonstrates. Printed in the PDF. */
  description: string;
  kind: EvidenceSourceKind;
  /**
   * The Infrawrench permission that reads the underlying data. A caller
   * without it gets the source as `unavailable` (with the permission named)
   * rather than a 403 for the whole status screen. Scheduled packs render
   * with full access, the dashboard-schedule rule (creating a schedule needs
   * `org:settings:write`).
   */
  permission: string;
  /** The workspace tab or settings section an operator fixes a gap from. */
  surface: string;
}

export const EVIDENCE_SOURCES: Record<BuiltinEvidenceSourceId, EvidenceSourceDefinition> = {
  "access-review": {
    id: "access-review",
    label: "Access review",
    description:
      "Principals inside connected clouds (users, roles, service accounts, keys) with stale, admin, unowned and past-rotation findings, and the decisions taken on them.",
    kind: "snapshot",
    permission: "resources:read",
    surface: "Access review",
  },
  "jit-access": {
    id: "jit-access",
    label: "Just-in-time access",
    description:
      "Time-boxed cloud role requests: who asked, who approved, for how long, and whether every grant was removed when its window ended.",
    kind: "period",
    permission: "access:read",
    surface: "Just-in-time access",
  },
  "audit-log": {
    id: "audit-log",
    label: "Audit log",
    description:
      "Every change made through Infrawrench, attributed to a member or API key, with its timestamp.",
    kind: "period",
    permission: "audit:read",
    surface: "Settings > Audit log",
  },
  posture: {
    id: "posture",
    label: "Posture checks",
    description:
      "Configuration findings over synced resources: public exposure, missing encryption, stale credentials, missing backup or deletion protection, and accepted risks.",
    kind: "snapshot",
    permission: "resources:read",
    surface: "Posture",
  },
  vulnerabilities: {
    id: "vulnerabilities",
    label: "Vulnerability management",
    description:
      "Open scanner findings by severity, split by whether the affected artifact is running, their age against fix targets, and findings fixed during the period with their time to fix.",
    kind: "snapshot",
    permission: "resources:read",
    surface: "Vulnerabilities",
  },
  "backup-coverage": {
    id: "backup-coverage",
    label: "Backup coverage",
    description:
      "Stateful resources and the backups protecting them, judged against the org's recovery point and retention objectives.",
    kind: "snapshot",
    permission: "resources:read",
    surface: "Backups",
  },
  "restore-drills": {
    id: "restore-drills",
    label: "Restore drills",
    description:
      "Recorded restore tests per protected resource: outcome, measured recovery time, and which resources are untested or overdue.",
    kind: "period",
    permission: "resources:read",
    surface: "Backups > Drills",
  },
  "change-timeline": {
    id: "change-timeline",
    label: "Change timeline",
    description:
      "Resources created, changed and deleted across every connected account, recorded between polls whether or not the change went through Infrawrench.",
    kind: "period",
    permission: "resources:read",
    surface: "Changes",
  },
  "change-freezes": {
    id: "change-freezes",
    label: "Change freezes",
    description: "Windows during which Infrawrench refused changes, who opened them and why.",
    kind: "period",
    permission: "freezes:read",
    surface: "Change freezes",
  },
  "session-recordings": {
    id: "session-recordings",
    label: "Session recordings",
    description:
      "Whether interactive SSH sessions are recorded, the retention applied, and the sessions recorded during the period.",
    kind: "period",
    permission: "session-recordings:read",
    surface: "Settings > Session recording",
  },
  incidents: {
    id: "incidents",
    label: "Incidents and postmortems",
    description:
      "Declared incidents with their timelines, time to mitigate and resolve, and whether each resolved incident has a written follow-up.",
    kind: "period",
    permission: "incidents:read",
    surface: "Incidents",
  },
};

/**
 * Sources added at runtime by a later feature (scorecards, leaked
 * credentials). Kept apart from the built-in table so the built-in ids stay a
 * closed union for the tests; {@link getEvidenceSource} reads both.
 */
const extraSources = new Map<EvidenceSourceId, EvidenceSourceDefinition>();

/**
 * Extension point: register an evidence source that is not built in. Call it
 * at module load on every host that renders compliance (the server evaluator
 * module and the shared UI both import client-core, so one call site in a
 * client-core module is enough). Re-registering an id replaces it.
 */
export function registerEvidenceSource(def: EvidenceSourceDefinition): void {
  extraSources.set(def.id, def);
}

export function getEvidenceSource(id: EvidenceSourceId): EvidenceSourceDefinition | undefined {
  return (EVIDENCE_SOURCES as Record<string, EvidenceSourceDefinition>)[id] ?? extraSources.get(id);
}

export function listEvidenceSources(): EvidenceSourceDefinition[] {
  return [...Object.values(EVIDENCE_SOURCES), ...extraSources.values()];
}
