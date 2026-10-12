import {
  IAC_STATUS_LABELS,
  POSTURE_SEVERITY_LABELS,
  SERVICE_TIER_LABELS,
  describeResourceVulnerabilities,
  fetchResourceCostEstimate,
  fetchResourceSpend,
  fetchResourceVulnerabilities,
  formatMonthlyEstimate,
  partialEstimatePrefix,
  postureFindingsByResource,
  type CloudFetch,
  type IacReconciliationEntry,
  type PostureFinding,
  type PostureListResponse,
  type ResourceSpend,
  type ResourceVulnerabilityTally,
  type ServiceRef,
} from "@infrawrench/client-core";
import type { TtlCache } from "./cache";
import { commandLink, escapeMarkdown } from "./markdown";

type CostEstimate = NonNullable<Awaited<ReturnType<typeof fetchResourceCostEstimate>>>;

/**
 * What the Terraform hover says about each live resource, as an ordered list
 * of sections. Each section loads its data for every resource in the hover at
 * once (one request, not one per resource) and renders a few Markdown lines
 * per resource.
 *
 * This list is the extension point: a new kind of finding (vulnerabilities,
 * leaked secrets, compliance controls) is one more `ResourceSection` appended
 * to `RESOURCE_SECTIONS`, and the hover, the CodeLens summary and the tests
 * pick it up without further wiring.
 */
export interface SectionContext {
  api: CloudFetch;
  orgId: string;
  caches: SectionCaches;
}

export interface SectionCaches {
  /** Org-wide reads shared across hovers, keyed by org id. */
  posture: TtlCache<PostureListResponse>;
  /** Per-resource results, keyed by `<section>:<org>:<resource>`. */
  perResource: TtlCache<unknown>;
}

export interface ResourceSection<T> {
  id: string;
  load(ctx: SectionContext, resources: readonly IacReconciliationEntry[]): Promise<Map<string, T>>;
  /** Markdown lines for one resource; empty to say nothing. */
  render(value: T | undefined, resource: IacReconciliationEntry): string[];
  /**
   * A short CodeLens fragment ("2 critical"), or null. Only sections whose
   * data is cheap or already cached should return one.
   */
  lens?(value: T | undefined, resource: IacReconciliationEntry): string | null;
}

/** Load one value per resource through the per-resource cache. */
async function perResource<T>(
  ctx: SectionContext,
  section: string,
  resources: readonly IacReconciliationEntry[],
  loadMany: (missing: readonly IacReconciliationEntry[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  // One batched request for the whole set, memoised per resource so a second
  // hover over the same block is instant. The batch starts only on a miss.
  let batch: Promise<Map<string, T>> | null = null;
  const out = new Map<string, T>();
  await Promise.all(
    resources.map(async (r) => {
      const value = (await ctx.caches.perResource.get(
        `${section}:${ctx.orgId}:${r.resourceId}`,
        async () => (await (batch ??= loadMany(resources))).get(r.resourceId) ?? null,
      )) as T | null;
      if (value !== null) out.set(r.resourceId, value);
    }),
  );
  return out;
}

const iacSection: ResourceSection<null> = {
  id: "iac",
  load: () => Promise.resolve(new Map()),
  render(_value, r) {
    const label = IAC_STATUS_LABELS[r.status];
    if (r.status === "drifted") {
      const fields = r.drift.map((d) => `\`${d.field}\``).slice(0, 5);
      const more = r.drift.length > fields.length ? `, +${r.drift.length - fields.length}` : "";
      return [
        `**${label}**: ${r.drift.length} field(s) differ from state (${fields.join(", ")}${more})`,
      ];
    }
    if (r.unmappableReason)
      return [`**${label}** (drift not computable: ${escapeMarkdown(r.unmappableReason)})`];
    return [`**${label}** by Terraform`];
  },
  lens: (_v, r) => (r.status === "drifted" ? `drifted (${r.drift.length})` : null),
};

const serviceSection: ResourceSection<ServiceRef[]> = {
  id: "service",
  async load(ctx, resources) {
    return perResource(ctx, "service", resources, async (list) => {
      const ids = list.map((r) => r.resourceId);
      const res = await ctx.api.org<{ services: Record<string, ServiceRef[]> }>(
        ctx.orgId,
        `/services/for-resources?ids=${encodeURIComponent(ids.join(","))}`,
      );
      return new Map(Object.entries(res?.services ?? {}));
    });
  },
  render(services) {
    if (!services || services.length === 0) return ["Service: none"];
    const parts = services.map((s) => {
      const tier = s.tier ? ` (${SERVICE_TIER_LABELS[s.tier]})` : "";
      return `${commandLink(s.name, "infrawrench.openService", [{ id: s.id }])}${escapeMarkdown(tier)}`;
    });
    return [`Service: ${parts.join(", ")}`];
  },
  lens: (services) => (services && services[0] ? services[0].name : null),
};

const spendSection: ResourceSection<ResourceSpend[]> = {
  id: "spend",
  async load(ctx, resources) {
    const withIds = resources.filter((r) => r.externalId);
    return perResource(ctx, "spend", withIds, async (list) => {
      const byExternal = await fetchResourceSpend(
        ctx.api,
        ctx.orgId,
        list.map((r) => ({ externalId: r.externalId!, accountId: r.accountId })),
      );
      const out = new Map<string, ResourceSpend[]>();
      for (const r of list) {
        const spend = byExternal.get(r.externalId!);
        if (spend) out.set(r.resourceId, spend);
      }
      return out;
    });
  },
  render(spend) {
    if (!spend || spend.length === 0) return ["Cost (last 30 days): no cost data"];
    return [
      `Cost (last 30 days): ${spend.map((s) => formatMonthlyEstimate(round2(s.amount), s.currency)).join(" + ")}`,
    ];
  },
  lens: (spend) =>
    spend && spend.length > 0
      ? `${spend.map((s) => formatMonthlyEstimate(round2(s.amount), s.currency)).join(" + ")} / 30d`
      : null,
};

/** The plugin's forward estimate. Calls the provider, so only small hovers ask. */
const ESTIMATE_MAX_RESOURCES = 3;

const estimateSection: ResourceSection<CostEstimate> = {
  id: "estimate",
  async load(ctx, resources) {
    const few = resources.slice(0, ESTIMATE_MAX_RESOURCES);
    return perResource(ctx, "estimate", few, async (list) => {
      const out = new Map<string, CostEstimate>();
      await Promise.all(
        list.map(async (r) => {
          try {
            const estimate = await fetchResourceCostEstimate(ctx.api, ctx.orgId, {
              accountId: r.accountId,
              resourceTypeId: r.resourceTypeId,
              resourceId: r.resourceId,
            });
            if (estimate) out.set(r.resourceId, estimate);
          } catch {
            // No estimate is a normal answer; a failed one reads the same.
          }
        }),
      );
      return out;
    });
  },
  render(estimate) {
    if (!estimate) return [];
    const prefix = partialEstimatePrefix(estimate);
    const amount = formatMonthlyEstimate(estimate.monthlyAmount, estimate.currency);
    return [`Estimate: ${prefix ? `${prefix} ` : ""}${amount}/month at list price`];
  },
};

const postureSection: ResourceSection<PostureFinding[]> = {
  id: "posture",
  async load(ctx) {
    const feed = await ctx.caches.posture.get(ctx.orgId, async () => {
      const res = await ctx.api.org<PostureListResponse>(ctx.orgId, "/posture");
      return res ?? emptyPosture();
    });
    return postureFindingsByResource(feed);
  },
  render(findings) {
    if (!findings || findings.length === 0) return ["Posture: no open findings"];
    const lines = [`Posture: ${findings.length} open finding(s)`];
    for (const f of findings.slice(0, 5)) {
      lines.push(`- ${POSTURE_SEVERITY_LABELS[f.severity]}: ${escapeMarkdown(f.title)}`);
    }
    if (findings.length > 5) lines.push(`- and ${findings.length - 5} more`);
    return lines;
  },
  lens(findings) {
    if (!findings || findings.length === 0) return null;
    const worst = findings[0]!.severity;
    return `${findings.length} finding(s), worst ${POSTURE_SEVERITY_LABELS[worst].toLowerCase()}`;
  },
};

/**
 * Open CVEs running on the resource, from the org's scanners (one
 * `GET /vulnerabilities?resourceId=…` read for the whole hover). An org with
 * no scanner gets no line at all: "none" there would claim a scan that never
 * happened.
 */
const vulnerabilitySection: ResourceSection<ResourceVulnerabilityTally> = {
  id: "vulnerabilities",
  async load(ctx, resources) {
    return perResource(ctx, "vulnerabilities", resources, async (list) => {
      const res = await fetchResourceVulnerabilities(
        ctx.api,
        ctx.orgId,
        list.map((r) => r.resourceId),
      );
      return res.byResource;
    });
  },
  render(tally) {
    if (!tally) return [];
    if (tally.total === 0) return ["Vulnerabilities: none"];
    return [
      `Vulnerabilities: ${commandLink(describeResourceVulnerabilities(tally), "infrawrench.openVulnerabilities", [])}`,
    ];
  },
  lens(tally) {
    if (!tally || tally.critical + tally.high === 0) return null;
    const parts = [
      tally.critical > 0 ? `${tally.critical} critical` : null,
      tally.high > 0 ? `${tally.high} high` : null,
    ].filter(Boolean);
    return `${parts.join(", ")} CVE${tally.critical + tally.high === 1 ? "" : "s"}`;
  },
};

function emptyPosture(): PostureListResponse {
  return {
    findings: [],
    totalCount: 0,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    dismissed: [],
    dismissedCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The hover's sections, in display order. Append here to add a kind of
 * finding (see the module comment).
 */
export const RESOURCE_SECTIONS: ResourceSection<unknown>[] = [
  iacSection,
  serviceSection,
  spendSection,
  estimateSection,
  postureSection,
  vulnerabilitySection,
] as ResourceSection<unknown>[];

export interface LoadedSections {
  /** Section id → resource id → value. */
  values: Map<string, Map<string, unknown>>;
  /** Sections whose load failed, with the reason (a 403 is a permission gap). */
  failures: Map<string, string>;
}

export async function loadSections(
  ctx: SectionContext,
  resources: readonly IacReconciliationEntry[],
  sections: readonly ResourceSection<unknown>[] = RESOURCE_SECTIONS,
): Promise<LoadedSections> {
  const values = new Map<string, Map<string, unknown>>();
  const failures = new Map<string, string>();
  await Promise.all(
    sections.map(async (s) => {
      try {
        values.set(s.id, await s.load(ctx, resources));
      } catch (err) {
        failures.set(s.id, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  return { values, failures };
}

/** Markdown lines for one resource across every section that loaded. */
export function renderResource(
  loaded: LoadedSections,
  resource: IacReconciliationEntry,
  sections: readonly ResourceSection<unknown>[] = RESOURCE_SECTIONS,
): string[] {
  const lines: string[] = [];
  for (const s of sections) {
    if (loaded.failures.has(s.id)) continue;
    lines.push(...s.render(loaded.values.get(s.id)?.get(resource.resourceId), resource));
  }
  return lines;
}

/** The comma-joined CodeLens fragments for one resource. */
export function lensSummary(
  loaded: LoadedSections,
  resource: IacReconciliationEntry,
  sections: readonly ResourceSection<unknown>[] = RESOURCE_SECTIONS,
): string[] {
  const parts: string[] = [];
  for (const s of sections) {
    if (!s.lens || loaded.failures.has(s.id)) continue;
    const part = s.lens(loaded.values.get(s.id)?.get(resource.resourceId), resource);
    if (part) parts.push(part);
  }
  return parts;
}
