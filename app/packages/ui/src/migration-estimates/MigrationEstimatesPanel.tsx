import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  formatCatalogMonthly,
  type MigrationCost,
  type MigrationEstimate,
  type MigrationEstimateInput,
  type MigrationEstimateResult,
  type MigrationMoney,
  type MigrationRow,
  type MigrationSizeOption,
  type MigrationTargetProvider,
  type MigrationTerraformResult,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { useDataString } from "../i18n/data-strings.js";
import { MigrationEstimatesIcon } from "./MigrationEstimatesIcon.js";
import { NewMigrationEstimateModal } from "./NewMigrationEstimateModal.js";
import {
  useAreaLabel,
  useBasisLabel,
  useCategoryLabel,
  useNoteLabel,
  useUnmatchedLabel,
} from "./labels.js";
import type { MigrationEstimatesClient, MigrationResourceRef } from "./types.js";

export interface MigrationEstimatesPanelProps {
  client: MigrationEstimatesClient;
  /** The open estimate; undefined shows the list. */
  estimateId?: string | undefined;
  /** Open an estimate (or go back to the list with null). Hosts mirror it into the URL. */
  onEstimateChange: (estimateId: string | null) => void;
  /** A row's source resource: the host opens its detail view. */
  onOpenResource?: ((ref: MigrationResourceRef) => void) | undefined;
}

const buttonClass =
  "rounded-lg border border-border px-2.5 py-1 text-sm text-on-surface-secondary hover:text-on-surface hover:bg-surface-sunken disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
const inputClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle";
const selectSmallClass =
  "max-w-[14rem] rounded-md border border-border bg-surface-sunken px-1.5 py-1 text-xs text-on-surface focus:outline-none focus:border-accent-subtle";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function money(m: MigrationMoney): string {
  return formatCatalogMonthly(m.amount, m.currency);
}

function moneyList(list: readonly MigrationMoney[]): string {
  return list.map(money).join(" + ");
}

function specsText(specs: {
  vcpus: number | null;
  memoryGb: number | null;
  gpuCount?: number | null;
}): string {
  const parts: string[] = [];
  if (specs.vcpus !== null) parts.push(`${specs.vcpus} vCPU`);
  if (specs.memoryGb !== null) parts.push(`${Math.round(specs.memoryGb * 10) / 10} GB`);
  if (specs.gpuCount) parts.push(`${specs.gpuCount} GPU`);
  return parts.join(" · ");
}

/** Same download path the cost and resource reports use. */
function saveTextFile(filename: string, mediaType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function firstOfNextMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
}

function inputOf(estimate: MigrationEstimate): MigrationEstimateInput {
  return {
    name: estimate.name,
    source: estimate.source,
    targetPluginId: estimate.targetPluginId,
    targetRegion: estimate.targetRegion,
    overrides: estimate.overrides,
  };
}

/**
 * Migration estimates: what a service, or a set of resources, would cost on
 * another provider. A list of the org's saved estimates, and one estimate as a
 * side-by-side table of each resource's cost today and on the target.
 */
export function MigrationEstimatesPanel({
  client,
  estimateId,
  onEstimateChange,
  onOpenResource,
}: MigrationEstimatesPanelProps) {
  if (estimateId) {
    return (
      <EstimateView
        key={estimateId}
        client={client}
        estimateId={estimateId}
        onBack={() => onEstimateChange(null)}
        onOpenResource={onOpenResource}
      />
    );
  }
  return <EstimateList client={client} onOpen={(id) => onEstimateChange(id)} />;
}

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

function EstimateList({
  client,
  onOpen,
}: {
  client: MigrationEstimatesClient;
  onOpen: (id: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [estimates, setEstimates] = useState<MigrationEstimate[] | null>(null);
  const [targets, setTargets] = useState<MigrationTargetProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.list(), client.targets().catch(() => [])])
      .then(([list, providers]) => {
        if (cancelled) return;
        setEstimates(list);
        setTargets(providers);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const providerName = (pluginId: string) => {
    const name = targets.find((t) => t.pluginId === pluginId)?.pluginName;
    return name ? gtData(name) : pluginId;
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MigrationEstimatesIcon size={18} className="text-on-surface-secondary" />
        <h1 className="flex-1 text-lg font-semibold text-on-surface">
          {gt("Migration estimates")}
        </h1>
        {client.create && (
          <button type="button" className={primaryClass} onClick={() => setCreating(true)}>
            {gt("New estimate")}
          </button>
        )}
      </div>
      {error && <ErrorNotice message={error} className="mb-3" />}
      {estimates === null && !error ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : estimates && estimates.length === 0 ? (
        <div className="rounded-xl border border-border p-6 text-sm text-on-surface-faint">
          {gt(
            "No estimates yet. Start one from a service, from resources selected in a resource report, or with New estimate.",
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("Name")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("Source")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("Target")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("Updated")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(estimates ?? []).map((e) => (
                <tr key={e.id} className="border-t border-border hover:bg-surface-sunken/60">
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      className="text-left font-medium text-on-surface underline-offset-2 hover:underline"
                      onClick={() => onOpen(e.id)}
                    >
                      {e.name}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-on-surface-secondary">
                    {e.source.kind === "service"
                      ? (e.sourceName ?? gt("Deleted service"))
                      : gt("{count} resources", { count: e.source.resourceIds.length })}
                  </td>
                  <td className="px-3 py-1.5 text-on-surface-secondary">
                    {providerName(e.targetPluginId)}
                    {e.targetRegion ? ` · ${e.targetRegion}` : ""}
                  </td>
                  <td className="px-3 py-1.5 text-on-surface-faint">
                    {new Date(e.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewMigrationEstimateModal
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            onOpen(created.id);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One estimate
 * ------------------------------------------------------------------ */

function EstimateView({
  client,
  estimateId,
  onBack,
  onOpenResource,
}: {
  client: MigrationEstimatesClient;
  estimateId: string;
  onBack: () => void;
  onOpenResource: ((ref: MigrationResourceRef) => void) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const areaLabel = useAreaLabel();
  const [estimate, setEstimate] = useState<MigrationEstimate | null>(null);
  const [targets, setTargets] = useState<MigrationTargetProvider[]>([]);
  const [result, setResult] = useState<MigrationEstimateResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [modal, setModal] = useState<"terraform" | "scenario" | "rename" | "delete" | null>(null);
  const canWrite = Boolean(client.update);

  const run = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    try {
      setResult(await client.result(estimateId));
    } catch (e) {
      setRunError(errorText(e));
    } finally {
      setRunning(false);
    }
  }, [client, estimateId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.get(estimateId), client.targets().catch(() => [])])
      .then(([saved, providers]) => {
        if (cancelled) return;
        setEstimate(saved);
        setTargets(providers);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorText(e));
      });
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, estimateId, run]);

  const save = useCallback(
    async (next: MigrationEstimateInput) => {
      if (!client.update) return;
      setRunError(null);
      try {
        setEstimate(await client.update(estimateId, next));
        await run();
      } catch (e) {
        setRunError(errorText(e));
      }
    },
    [client, estimateId, run],
  );

  if (loadError) {
    return (
      <div>
        <button type="button" className={buttonClass} onClick={onBack}>
          {gt("Back to estimates")}
        </button>
        <ErrorNotice message={loadError} className="mt-4" />
      </div>
    );
  }

  const target = targets.find((t) => t.pluginId === estimate?.targetPluginId) ?? null;
  const setOverride = (resourceId: string, patch: { resourceTypeId?: string; sizeId?: string }) => {
    if (!estimate) return;
    const overrides = { ...estimate.overrides };
    const nextEntry = { ...(overrides[resourceId] ?? {}), ...patch };
    // Changing the type invalidates a size picked for the old one.
    if (patch.resourceTypeId !== undefined) delete nextEntry.sizeId;
    if (!nextEntry.resourceTypeId) delete nextEntry.resourceTypeId;
    if (!nextEntry.sizeId) delete nextEntry.sizeId;
    if (Object.keys(nextEntry).length === 0) delete overrides[resourceId];
    else overrides[resourceId] = nextEntry;
    void save({ ...inputOf(estimate), overrides });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} onClick={onBack}>
          {gt("Back to estimates")}
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-on-surface">
          {estimate?.name ?? result?.name ?? ""}
        </h1>
        <button type="button" className={buttonClass} disabled={running} onClick={() => void run()}>
          {running ? gt("Pricing…") : gt("Refresh")}
        </button>
        {result?.terraform && (
          <button type="button" className={buttonClass} onClick={() => setModal("terraform")}>
            {gt("Terraform")}
          </button>
        )}
        {client.createScenario && result?.totals.comparable && (
          <button type="button" className={buttonClass} onClick={() => setModal("scenario")}>
            {gt("Create scenario")}
          </button>
        )}
        {canWrite && estimate && (
          <button type="button" className={buttonClass} onClick={() => setModal("rename")}>
            {gt("Rename")}
          </button>
        )}
        {client.remove && estimate && (
          <button type="button" className={buttonClass} onClick={() => setModal("delete")}>
            {gt("Delete")}
          </button>
        )}
      </div>

      {estimate && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label
              className="block text-xs font-medium text-on-surface-secondary mb-1"
              htmlFor="migration-estimate-target"
            >
              {gt("Target provider")}
            </label>
            <select
              id="migration-estimate-target"
              className={inputClass}
              value={estimate.targetPluginId}
              disabled={!canWrite || running}
              onChange={(e) =>
                void save({
                  ...inputOf(estimate),
                  targetPluginId: e.target.value,
                  targetRegion: null,
                  overrides: {},
                })
              }
            >
              {targets.length === 0 && (
                <option value={estimate.targetPluginId}>{estimate.targetPluginId}</option>
              )}
              {targets.map((t) => (
                <option key={t.pluginId} value={t.pluginId}>
                  {gtData(t.pluginName)}
                </option>
              ))}
            </select>
          </div>
          {target && target.regions.length > 0 && (
            <div>
              <label
                className="block text-xs font-medium text-on-surface-secondary mb-1"
                htmlFor="migration-estimate-region"
              >
                {gt("Region")}
              </label>
              <select
                id="migration-estimate-region"
                className={inputClass}
                value={estimate.targetRegion ?? ""}
                disabled={!canWrite || running}
                onChange={(e) =>
                  void save({ ...inputOf(estimate), targetRegion: e.target.value || null })
                }
              >
                <option value="">{gt("Nearest to the resources")}</option>
                {target.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.area ? `${r.label} (${areaLabel(r.area)})` : r.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {estimate.source.kind === "service" && estimate.sourceName && (
            <p className="pb-1.5 text-sm text-on-surface-secondary">
              {gt("Service: {name}", { name: estimate.sourceName })}
            </p>
          )}
        </div>
      )}

      {runError && <ErrorNotice message={runError} className="mb-3" />}
      {result ? (
        <EstimateResult
          result={result}
          running={running}
          canWrite={canWrite}
          onOverride={setOverride}
          onOpenResource={onOpenResource}
        />
      ) : (
        !runError && (
          <div className="rounded-xl border border-border p-6 text-sm text-on-surface-faint">
            {gt("Pricing…")}
          </div>
        )
      )}

      {modal === "terraform" && (
        <TerraformModal
          load={() => client.terraform(estimateId)}
          filename={`${(estimate?.name ?? "migration").replace(/[^a-z0-9-_]+/gi, "-")}.tf`}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "scenario" && result?.totals.comparable && client.createScenario && (
        <ScenarioModal
          result={result}
          onClose={() => setModal(null)}
          onCreate={(input) => client.createScenario!(estimateId, input)}
        />
      )}
      {modal === "rename" && estimate && (
        <RenameModal
          name={estimate.name}
          onClose={() => setModal(null)}
          onSave={async (name) => {
            await save({ ...inputOf(estimate), name });
            setModal(null);
          }}
        />
      )}
      {modal === "delete" && estimate && client.remove && (
        <DeleteModal
          name={estimate.name}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await client.remove!(estimateId);
            onBack();
          }}
        />
      )}
    </div>
  );
}

function CostCell({ cost }: { cost: MigrationCost | null }) {
  const gt = useGT();
  const basisLabel = useBasisLabel();
  if (!cost) return <span className="text-on-surface-faint">{gt("Unknown")}</span>;
  return (
    <span>
      <span className="tabular-nums text-on-surface">
        {cost.partial ? gt("at least {amount}", { amount: money(cost) }) : money(cost)}
      </span>
      <span className="ml-1 text-[11px] text-on-surface-faint">{basisLabel(cost.basis)}</span>
    </span>
  );
}

function deltaText(row: MigrationRow): { text: string; tone: string } | null {
  const cur = row.current;
  const tgt = row.target.cost;
  if (!cur || !tgt || cur.currency !== tgt.currency) return null;
  const delta = tgt.amount - cur.amount;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return {
    text: `${sign}${formatCatalogMonthly(Math.abs(delta), tgt.currency)}`,
    tone: delta > 0 ? "text-danger" : delta < 0 ? "text-success" : "text-on-surface-faint",
  };
}

function sizeOptionLabel(option: MigrationSizeOption): string {
  const specs = specsText(option);
  const price = option.monthly ? money(option.monthly) : "";
  return [option.label, specs, price].filter(Boolean).join(" · ");
}

function EstimateResult({
  result,
  running,
  canWrite,
  onOverride,
  onOpenResource,
}: {
  result: MigrationEstimateResult;
  running: boolean;
  canWrite: boolean;
  onOverride: (resourceId: string, patch: { resourceTypeId?: string; sizeId?: string }) => void;
  onOpenResource: ((ref: MigrationResourceRef) => void) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const categoryLabel = useCategoryLabel();
  const noteLabel = useNoteLabel();
  const unmatchedLabel = useUnmatchedLabel();
  const areaLabel = useAreaLabel();
  const { totals, region } = result;
  const comparable = totals.comparable;
  const providerName = gtData(result.target.pluginName);

  const regionLine = useMemo(() => {
    const where = region.regionLabel ?? region.region;
    if (!where) return gt("Priced in the provider's default region.");
    const area = region.area ? areaLabel(region.area) : null;
    const place = area ? `${where} (${area})` : where;
    if (region.choice === "nearest") {
      return gt("Priced in {region}, the nearest region to the resources.", { region: place });
    }
    if (region.choice === "default") {
      return gt("Priced in {region}: the resources' location is unknown.", { region: place });
    }
    return gt("Priced in {region}.", { region: place });
  }, [region, gt, areaLabel]);

  return (
    <div className={running ? "opacity-60" : ""} aria-busy={running}>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs text-on-surface-faint">{gt("Today")}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-on-surface">
            {comparable
              ? formatCatalogMonthly(comparable.current, comparable.currency)
              : totals.current.length > 0
                ? moneyList(totals.current)
                : gt("Unknown")}
          </p>
          {totals.currentUnknown > 0 && (
            <p className="mt-1 text-xs text-on-surface-faint">
              {gt("{count} resources not priced", { count: totals.currentUnknown })}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs text-on-surface-faint">
            {gt("On {provider}", { provider: providerName })}
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-on-surface">
            {comparable
              ? formatCatalogMonthly(comparable.target, comparable.currency)
              : totals.target.length > 0
                ? moneyList(totals.target)
                : gt("Unknown")}
          </p>
          {totals.targetUnknown > 0 && (
            <p className="mt-1 text-xs text-on-surface-faint">
              {gt("{count} resources not priced", { count: totals.targetUnknown })}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs text-on-surface-faint">{gt("Change per month")}</p>
          {comparable && comparable.pairedRows > 0 ? (
            <>
              <p
                className={`mt-1 text-xl font-semibold tabular-nums ${
                  comparable.pairedDelta < 0
                    ? "text-success"
                    : comparable.pairedDelta > 0
                      ? "text-danger"
                      : "text-on-surface"
                }`}
              >
                {comparable.pairedDelta > 0 ? "+" : comparable.pairedDelta < 0 ? "−" : ""}
                {formatCatalogMonthly(Math.abs(comparable.pairedDelta), comparable.currency)}
              </p>
              <p className="mt-1 text-xs text-on-surface-faint">
                {gt("Over the {count} resources priced on both sides", {
                  count: comparable.pairedRows,
                })}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-on-surface-faint">
              {comparable
                ? gt("No resource is priced on both sides yet.")
                : gt("Mixed currencies: set exchange rates in Settings to compare.")}
            </p>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-1 text-xs text-on-surface-secondary">
        <p>{regionLine}</p>
        {region.crossesArea && (
          <p className="text-warning">
            {gt(
              "Some resources run in another part of the world than this region, so latency to their users will change.",
            )}
          </p>
        )}
        {result.truncated && (
          <p className="text-warning">{gt("Only the first 500 resources are estimated.")}</p>
        )}
      </div>

      {result.rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("Resource")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("Size today")}
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-right font-medium text-on-surface-secondary"
                >
                  {gt("Today")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-on-surface-secondary">
                  {gt("On {provider}", { provider: providerName })}
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-right font-medium text-on-surface-secondary"
                >
                  {gt("Estimate")}
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-right font-medium text-on-surface-secondary"
                >
                  {gt("Change")}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => {
                const delta = deltaText(row);
                const specs = specsText(row.specs);
                return (
                  <tr key={row.resourceId} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      {onOpenResource ? (
                        <button
                          type="button"
                          className="text-left font-medium text-on-surface underline-offset-2 hover:underline"
                          onClick={() =>
                            onOpenResource({
                              accountId: row.accountId,
                              resourceId: row.resourceId,
                              pluginId: row.pluginId,
                              resourceTypeId: row.resourceTypeId,
                            })
                          }
                        >
                          {row.displayName}
                        </button>
                      ) : (
                        <span className="font-medium text-on-surface">{row.displayName}</span>
                      )}
                      <p className="text-xs text-on-surface-faint">
                        {gtData(row.pluginName)} · {gtData(row.resourceTypeName)} ·{" "}
                        {categoryLabel(row.category)}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-xs text-on-surface-secondary">
                      {row.instanceType && <p className="text-on-surface">{row.instanceType}</p>}
                      {specs && <p>{specs}</p>}
                      {row.specs.count > 1 && <p>{gt("× {count}", { count: row.specs.count })}</p>}
                      {row.sourceRegion && (
                        <p className="text-on-surface-faint">{row.sourceRegion}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <CostCell cost={row.current} />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.targetTypes.length > 1 && canWrite ? (
                        <select
                          className={selectSmallClass}
                          aria-label={gt("Target type")}
                          value={row.target.resourceTypeId}
                          onChange={(e) =>
                            onOverride(row.resourceId, { resourceTypeId: e.target.value })
                          }
                        >
                          {row.targetTypes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {gtData(t.name)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-on-surface">{gtData(row.target.resourceTypeName)}</p>
                      )}
                      {row.candidates.length > 0 &&
                        (canWrite ? (
                          <select
                            className={`${selectSmallClass} mt-1 block`}
                            aria-label={gt("Target size")}
                            value={row.target.sizeId ?? ""}
                            onChange={(e) => onOverride(row.resourceId, { sizeId: e.target.value })}
                          >
                            {!row.target.sizeId && <option value="">{gt("No match")}</option>}
                            {row.candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.meetsSpec
                                  ? sizeOptionLabel(c)
                                  : gt("{size} (smaller than today)", { size: sizeOptionLabel(c) })}
                              </option>
                            ))}
                          </select>
                        ) : (
                          row.target.sizeLabel && (
                            <p className="mt-1 text-on-surface-secondary">{row.target.sizeLabel}</p>
                          )
                        ))}
                      {row.target.sizeId && (
                        <p className="mt-1 text-on-surface-faint">
                          {specsText(row.target)}
                          {row.target.overridden ? ` · ${gt("chosen by you")}` : ""}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <CostCell cost={row.target.cost} />
                      {!row.target.cost && row.note && (
                        <p className="mt-0.5 text-[11px] text-on-surface-faint">
                          {noteLabel(row.note)}
                        </p>
                      )}
                    </td>
                    <td
                      className={`px-3 py-2 text-right whitespace-nowrap tabular-nums ${
                        delta?.tone ?? "text-on-surface-faint"
                      }`}
                    >
                      {delta?.text ?? "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {result.unmatched.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-on-surface">
            {gt("No equivalent on {provider}", { provider: providerName })}
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {result.unmatched.map((u) => (
              <li key={u.resourceId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium text-on-surface">{u.displayName}</span>
                <span className="text-xs text-on-surface-faint">
                  {gtData(u.pluginName)} · {gtData(u.resourceTypeName)}
                </span>
                <span className="ml-auto text-xs text-on-surface-secondary">
                  {u.category
                    ? `${unmatchedLabel(u.reason)} (${categoryLabel(u.category)})`
                    : unmatchedLabel(u.reason)}
                </span>
                {u.current && (
                  <span className="text-xs tabular-nums text-on-surface-secondary">
                    {money(u.current)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {totals.unmatchedCurrent.length > 0 && (
            <p className="mt-2 text-xs text-on-surface-faint">
              {gt("These cost {amount} a month today and are left out of the totals.", {
                amount: moneyList(totals.unmatchedCurrent),
              })}
            </p>
          )}
        </div>
      )}

      {result.rows.length === 0 && result.unmatched.length === 0 && (
        <div className="rounded-xl border border-border p-6 text-sm text-on-surface-faint">
          {gt("This estimate has no resources.")}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

function TerraformModal({
  load,
  filename,
  onClose,
}: {
  load: () => Promise<MigrationTerraformResult>;
  filename: string;
  onClose: () => void;
}) {
  const gt = useGT();
  const [terraform, setTerraform] = useState<MigrationTerraformResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((r) => {
        if (!cancelled) setTerraform(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return (
    <Modal onClose={onClose} ariaLabel={gt("Terraform for the target provider")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[760px] max-w-[95vw] p-6">
        <h2 className="mb-3 text-base font-semibold text-on-surface">
          {gt("Terraform for the target provider")}
        </h2>
        {error && <ErrorNotice message={error} className="mb-3" />}
        {!terraform && !error && <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>}
        {terraform && (
          <>
            {terraform.unsupported.length > 0 && (
              <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-on-surface-secondary">
                <p className="mb-1 font-medium text-on-surface">
                  {gt("Not in the file ({count})", { count: terraform.unsupported.length })}
                </p>
                <ul className="list-disc pl-4">
                  {terraform.unsupported.map((u) => (
                    <li key={u.resourceId}>
                      {u.displayName}: {u.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {terraform.hcl ? (
              <pre className="max-h-[50vh] overflow-auto rounded-lg bg-surface-sunken p-3 text-xs text-on-surface">
                {terraform.hcl}
              </pre>
            ) : (
              <p className="text-sm text-on-surface-faint">{gt("No resource could be mapped.")}</p>
            )}
          </>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {terraform?.hcl && (
            <>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  void navigator.clipboard?.writeText(terraform.hcl).then(() => setCopied(true));
                }}
              >
                {copied ? gt("Copied") : gt("Copy HCL")}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => saveTextFile(filename, "text/plain", terraform.hcl)}
              >
                {gt("Download")}
              </button>
            </>
          )}
          <button type="button" className={primaryClass} onClick={onClose}>
            {gt("Close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ScenarioModal({
  result,
  onClose,
  onCreate,
}: {
  result: MigrationEstimateResult;
  onClose: () => void;
  onCreate: (input: { startDate: string; name?: string }) => Promise<{ name: string }>;
}) {
  const gt = useGT();
  const [startDate, setStartDate] = useState(firstOfNextMonth);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const comparable = result.totals.comparable!;
  const delta = formatCatalogMonthly(Math.abs(comparable.pairedDelta), comparable.currency);
  return (
    <Modal onClose={onClose} ariaLabel={gt("Create scenario")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] max-w-[95vw] p-6">
        <h2 className="mb-2 text-base font-semibold text-on-surface">{gt("Create scenario")}</h2>
        {created ? (
          <p className="text-sm text-on-surface-secondary">
            {gt(
              "Created the scenario model {name}. Apply it to a cost graph or budget from the Costs page.",
              { name: created },
            )}
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-on-surface-secondary">
              {comparable.pairedDelta <= 0
                ? gt("A recurring saving of {amount} a month, from the date the migration lands.", {
                    amount: delta,
                  })
                : gt("A recurring cost of {amount} a month, from the date the migration lands.", {
                    amount: delta,
                  })}
            </p>
            <label
              className="block text-xs font-medium text-on-surface-secondary mb-1"
              htmlFor="migration-scenario-date"
            >
              {gt("Migration date")}
            </label>
            <input
              id="migration-scenario-date"
              type="date"
              className={`${inputClass} w-full`}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <label
              className="mt-3 block text-xs font-medium text-on-surface-secondary mb-1"
              htmlFor="migration-scenario-name"
            >
              {gt("Scenario name")}
            </label>
            <input
              id="migration-scenario-name"
              className={`${inputClass} w-full`}
              value={name}
              maxLength={120}
              placeholder={gt("{estimate} on {provider}", {
                estimate: result.name,
                provider: result.target.pluginName,
              })}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            {created ? gt("Close") : gt("Cancel")}
          </button>
          {!created && (
            <button
              type="button"
              className={primaryClass}
              disabled={busy || !startDate}
              onClick={() => {
                setBusy(true);
                setError(null);
                onCreate({ startDate, ...(name.trim() ? { name: name.trim() } : {}) })
                  .then((model) => setCreated(model.name))
                  .catch((e: unknown) => setError(errorText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {gt("Create")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function RenameModal({
  name,
  onClose,
  onSave,
}: {
  name: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const gt = useGT();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} ariaLabel={gt("Rename estimate")}>
      <form
        className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] max-w-[95vw] p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setBusy(true);
          onSave(value.trim()).catch((err: unknown) => {
            setError(errorText(err));
            setBusy(false);
          });
        }}
      >
        <h2 className="mb-3 text-base font-semibold text-on-surface">{gt("Rename estimate")}</h2>
        <input
          className={`${inputClass} w-full`}
          aria-label={gt("Name")}
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            {gt("Cancel")}
          </button>
          <button type="submit" className={primaryClass} disabled={busy || !value.trim()}>
            {gt("Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} ariaLabel={gt("Delete estimate")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] max-w-[95vw] p-6">
        <h2 className="mb-2 text-base font-semibold text-on-surface">{gt("Delete estimate")}</h2>
        <p className="text-sm text-on-surface-secondary">
          {gt("Delete {name}? The resources are not touched.", { name })}
        </p>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-lg bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            onClick={() => {
              setBusy(true);
              onConfirm().catch((e: unknown) => {
                setError(errorText(e));
                setBusy(false);
              });
            }}
          >
            {gt("Delete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
