/**
 * Assemble the compliance status for one framework and period: run every
 * evidence source the framework maps (once each, however many controls use
 * it), then hand the results and the org's decisions to the pure
 * `computeComplianceControls` in client-core.
 *
 * Sources run concurrently and each is isolated: a throw becomes that source
 * `unavailable` with the error recorded, and a caller without the source's
 * permission gets it `unavailable` naming the permission, never a 403 for
 * the whole screen.
 */
import {
  compliancePeriodBounds,
  computeComplianceControls,
  getComplianceFramework,
  getEvidenceSource,
  toFrameworkSummary,
  type ComplianceFrameworkDefinition,
  type CompliancePeriod,
  type ComplianceStatusResponse,
  type EvidenceSourceId,
} from "@infrawrench/client-core";
import { getEvidenceEvaluator, type EvidenceCollection, type EvidenceContext } from "./evidence";
import { ComplianceInputError, listComplianceControlSettings, loadOwnerNames } from "./settings";

export interface ComplianceStatusOptions {
  period: CompliancePeriod;
  now?: Date;
  /**
   * The caller's permissions, or null for full access (scheduled packs,
   * which `org:settings:write` created). `hasPermission` decides wildcards.
   */
  canRead: ((permission: string) => boolean) | null;
}

export interface ComplianceEvidenceBundle {
  status: ComplianceStatusResponse;
  framework: ComplianceFrameworkDefinition;
  /** Per source: the pack files. Absent for sources that did not run. */
  collections: Map<EvidenceSourceId, EvidenceCollection>;
}

function unavailable(sourceId: EvidenceSourceId, error: string): EvidenceCollection {
  const def = getEvidenceSource(sourceId);
  return {
    result: {
      sourceId,
      label: def?.label ?? sourceId,
      kind: def?.kind ?? "snapshot",
      status: "unavailable",
      summary: error,
      metrics: [],
      gaps: [],
      itemCount: 0,
      error,
    },
    csv: null,
    json: null,
  };
}

export function requireFramework(frameworkId: string | undefined): ComplianceFrameworkDefinition {
  if (!frameworkId) throw new ComplianceInputError("framework is required");
  const framework = getComplianceFramework(frameworkId);
  if (!framework) throw new ComplianceInputError(`Unknown framework: ${frameworkId}`, 404);
  return framework;
}

export async function collectComplianceEvidence(
  organizationId: string,
  frameworkId: string,
  opts: ComplianceStatusOptions,
): Promise<ComplianceEvidenceBundle> {
  const framework = requireFramework(frameworkId);
  const now = opts.now ?? new Date();
  const { start, end } = compliancePeriodBounds(opts.period);
  const ctx: EvidenceContext = { organizationId, period: opts.period, start, end, now };

  const sourceIds = [...new Set(framework.controls.flatMap((c) => c.sources))];
  const collections = new Map<EvidenceSourceId, EvidenceCollection>();
  await Promise.all(
    sourceIds.map(async (sourceId) => {
      const def = getEvidenceSource(sourceId);
      const evaluator = getEvidenceEvaluator(sourceId);
      if (!def || !evaluator) {
        collections.set(sourceId, unavailable(sourceId, "No evaluator is registered for this source."));
        return;
      }
      if (opts.canRead && !opts.canRead(def.permission)) {
        collections.set(
          sourceId,
          unavailable(sourceId, `Reading this evidence needs the ${def.permission} permission.`),
        );
        return;
      }
      try {
        collections.set(sourceId, await evaluator(ctx));
      } catch (err) {
        console.error(`[compliance] source ${sourceId} for org ${organizationId} failed:`, err);
        collections.set(
          sourceId,
          unavailable(sourceId, `This evidence could not be read: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }),
  );

  const settings = await listComplianceControlSettings(organizationId, framework.id);
  const memberNames = await loadOwnerNames(
    organizationId,
    settings.map((s) => s.ownerUserId).filter((id): id is string => id !== null),
  );
  const results = sourceIds.map((id) => collections.get(id)!.result);
  const { controls, counts } = computeComplianceControls({ framework, results, settings, memberNames });
  return {
    framework,
    collections,
    status: {
      framework: toFrameworkSummary(framework),
      period: opts.period,
      controls,
      sources: results,
      counts,
      generatedAt: now.toISOString(),
    },
  };
}

export async function getComplianceStatus(
  organizationId: string,
  frameworkId: string,
  opts: ComplianceStatusOptions,
): Promise<ComplianceStatusResponse> {
  return (await collectComplianceEvidence(organizationId, frameworkId, opts)).status;
}
