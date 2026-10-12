/**
 * The org-wide feeds a service summary and a scorecard read, loaded lazily
 * and at most once per evaluation.
 *
 * Every feed here already exists for its own page (posture, orphans, backup
 * coverage, restore drills, SLOs, runbooks, the tag policy, per-resource
 * spend) and is computed org-wide; a service is a filter over them. Scoring
 * thirty services must not mean thirty posture scans, so each feed is a
 * memoised promise on this object, created on first use.
 *
 * A feed that fails resolves to `null` rather than rejecting. The summary
 * reports it as unavailable and a scorecard check that needs it reports
 * `error`: one broken feed must never take the page or the pass down with it.
 *
 * {@link ServiceSignals.extension} is the hook for feeds that arrive later
 * (vulnerability findings, deploy metrics): a check registers its own loader
 * under its own key and gets the same once-per-evaluation memoisation.
 */
import type {
  BackupCoverageResponse,
  OrphanListResponse,
  PostureListResponse,
  Runbook,
  Slo,
  TagPolicy,
} from "@infrawrench/client-core";
import type { DrillCoverageResponse } from "../backups/drills";
import type { ResolvedOnCall } from "../on-call/store";

/** Trailing window per-resource spend is summed over. */
export const SERVICE_COST_WINDOW_DAYS = 30;

export interface ResourceSpend {
  amount: number;
  currency: string;
}

export class ServiceSignals {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(
    readonly organizationId: string,
    readonly now: number = Date.now(),
  ) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T | null> {
    let hit = this.cache.get(key) as Promise<T | null> | undefined;
    if (!hit) {
      hit = load().catch((err: unknown) => {
        console.warn(`[services] ${key} feed for org ${this.organizationId} unavailable:`, err);
        return null;
      });
      this.cache.set(key, hit);
    }
    return hit;
  }

  /** A feed contributed by a later integration. Same memoisation, same null-on-failure. */
  extension<T>(key: string, load: (organizationId: string) => Promise<T>): Promise<T | null> {
    return this.once(`ext:${key}`, () => load(this.organizationId));
  }

  posture(): Promise<PostureListResponse | null> {
    return this.once("posture", async () => {
      const { listPosture } = await import("../posture/feed");
      return listPosture(this.organizationId, { now: this.now });
    });
  }

  orphans(): Promise<OrphanListResponse | null> {
    return this.once("orphans", async () => {
      const { listOrphans } = await import("../savings/orphans");
      return listOrphans(this.organizationId, { includeCosts: false });
    });
  }

  backups(): Promise<BackupCoverageResponse | null> {
    return this.once("backups", async () => {
      const { listBackupCoverage } = await import("../backups/feed");
      return listBackupCoverage(this.organizationId, { now: this.now, skipCosts: true });
    });
  }

  drills(validDays: number): Promise<DrillCoverageResponse | null> {
    return this.once(`drills:${validDays}`, async () => {
      const { listDrillCoverage } = await import("../backups/drills");
      return listDrillCoverage(this.organizationId, { validDays, now: this.now });
    });
  }

  slos(): Promise<Slo[] | null> {
    return this.once("slos", async () => {
      const { listSlosWire } = await import("../slos/store");
      return listSlosWire(this.organizationId);
    });
  }

  runbooks(): Promise<Runbook[] | null> {
    return this.once("runbooks", async () => {
      const { listRunbooks } = await import("../runbooks/store");
      return listRunbooks(this.organizationId);
    });
  }

  tagPolicy(): Promise<TagPolicy | null> {
    return this.once("tag-policy", async () => {
      const { getOrgTagPolicy } = await import("../cost/tag-policy");
      return getOrgTagPolicy(this.organizationId);
    });
  }

  onCallSchedule(scheduleId: string) {
    return this.once(`on-call:${scheduleId}`, async () => {
      const { getOnCallSchedule } = await import("../on-call/store");
      return getOnCallSchedule(this.organizationId, scheduleId);
    });
  }

  onCallNow(scheduleId: string): Promise<ResolvedOnCall | null> {
    return this.once(`on-call-now:${scheduleId}`, async () => {
      const { resolveOnCallNow } = await import("../on-call/store");
      return resolveOnCallNow(this.organizationId, scheduleId, this.now);
    });
  }

  /**
   * Trailing spend per `"<accountId> <externalId>"`, summed per currency.
   *
   * Read through `getResourceCostTotals`, whose org predicate is
   * `costDailyOrgCondition`, so a request under a cost visibility scope sees
   * only the spend that scope allows; the poller has no scope and sees all.
   */
  resourceSpend(): Promise<Map<string, ResourceSpend[]> | null> {
    return this.once("spend", async () => {
      const { getResourceCostTotals } = await import("../clickhouse/cost-readers");
      const { addDays, isoDay } = await import("../cost/dates");
      const to = isoDay(new Date(this.now));
      const from = addDays(to, -(SERVICE_COST_WINDOW_DAYS - 1));
      const totals = await getResourceCostTotals(this.organizationId, from, to);
      const out = new Map<string, ResourceSpend[]>();
      for (const t of totals) {
        if (!t.currency) continue;
        const key = `${t.accountId} ${t.resourceId}`;
        const list = out.get(key) ?? [];
        const same = list.find((s) => s.currency === t.currency);
        if (same) same.amount += t.amount;
        else list.push({ amount: t.amount, currency: t.currency });
        out.set(key, list);
      }
      return out;
    });
  }
}
