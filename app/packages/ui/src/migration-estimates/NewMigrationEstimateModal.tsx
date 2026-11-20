import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import type {
  MigrationEstimate,
  MigrationEstimateSource,
  MigrationTargetProvider,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type { MigrationEstimatesClient } from "./types.js";

const buttonClass =
  "rounded-lg border border-border px-2.5 py-1 text-sm text-on-surface-secondary hover:text-on-surface hover:bg-surface-sunken disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface NewMigrationEstimateModalProps {
  client: MigrationEstimatesClient;
  /** What to price. Absent: the modal offers the org's services to pick from. */
  source?: { source: MigrationEstimateSource; label: string } | undefined;
  /** Providers to leave out (the source's own, when it is one provider). */
  excludePluginIds?: readonly string[] | undefined;
  onClose: () => void;
  onCreated: (estimate: MigrationEstimate) => void;
  /** Opens the Services tab, offered when the org has no services to pick. */
  onOpenServices?: (() => void) | undefined;
  /** Opens Resource reports, where a selection of resources can be estimated. */
  onOpenResourceReports?: (() => void) | undefined;
}

/**
 * Start an estimate: pick the provider to price on (and, optionally, the
 * region; the default is the one nearest the resources), name it, save it.
 * Shared by the Services page, resource report selections and the estimates
 * list.
 */
export function NewMigrationEstimateModal({
  client,
  source,
  excludePluginIds,
  onClose,
  onCreated,
  onOpenServices,
  onOpenResourceReports,
}: NewMigrationEstimateModalProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [targets, setTargets] = useState<MigrationTargetProvider[] | null>(null);
  const [services, setServices] = useState<Array<{ id: string; name: string }> | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [targetPluginId, setTargetPluginId] = useState("");
  const [targetRegion, setTargetRegion] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .targets()
      .then((list) => {
        if (!cancelled) setTargets(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    if (!source) {
      client
        .listServices()
        .then((list) => {
          if (!cancelled) setServices(list);
        })
        .catch(() => {
          if (!cancelled) setServices([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, source]);

  const offered = useMemo(
    () => (targets ?? []).filter((t) => !excludePluginIds?.includes(t.pluginId)),
    [targets, excludePluginIds],
  );
  const target = offered.find((t) => t.pluginId === targetPluginId) ?? null;
  const sourceLabel = source?.label ?? services?.find((s) => s.id === serviceId)?.name ?? "";

  // The name follows the choices until the user types one.
  useEffect(() => {
    if (nameTouched) return;
    if (sourceLabel && target) {
      setName(
        gt("{source} on {provider}", { source: sourceLabel, provider: gtData(target.pluginName) }),
      );
    }
  }, [sourceLabel, target, nameTouched, gt, gtData]);

  const effectiveSource: MigrationEstimateSource | null =
    source?.source ?? (serviceId ? { kind: "service", serviceId } : null);
  // Nothing to estimate: say where a source comes from instead of showing a
  // form that cannot be submitted.
  const noSource = !source && services !== null && services.length === 0;
  const canSubmit = Boolean(client.create && effectiveSource && target && name.trim() && !busy);

  async function submit() {
    if (!client.create || !effectiveSource || !target) return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.create({
        name: name.trim(),
        source: effectiveSource,
        targetPluginId: target.pluginId,
        targetRegion: targetRegion || null,
        overrides: {},
      });
      onCreated(created);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Estimate migration")}>
      <form
        className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[480px] max-w-[95vw] p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="mb-1 text-base font-semibold text-on-surface">{gt("Estimate migration")}</h2>
        {source && <p className="mb-4 text-sm text-on-surface-secondary">{source.label}</p>}
        {noSource ? (
          <div className="rounded-lg border border-border bg-surface-sunken p-4 text-sm">
            <p className="text-on-surface">{gt("There are no services to estimate yet.")}</p>
            <p className="mt-1 text-on-surface-secondary">
              {gt(
                "Create a service from the resources an app is made of, or select resources in a resource report and choose Estimate migration there.",
              )}
            </p>
            {(onOpenServices || onOpenResourceReports) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {onOpenServices && (
                  <button type="button" className={primaryClass} onClick={onOpenServices}>
                    {gt("Create a service")}
                  </button>
                )}
                {onOpenResourceReports && (
                  <button type="button" className={buttonClass} onClick={onOpenResourceReports}>
                    {gt("Open resource reports")}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {!source && (
              <div>
                <label className={labelClass} htmlFor="migration-service">
                  {gt("Service")}
                </label>
                <select
                  id="migration-service"
                  className={inputClass}
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  disabled={services === null}
                >
                  <option value="">
                    {services === null ? gt("Loading…") : gt("Choose a service")}
                  </option>
                  {(services ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor="migration-target">
                {gt("Target provider")}
              </label>
              <select
                id="migration-target"
                className={inputClass}
                value={targetPluginId}
                onChange={(e) => {
                  setTargetPluginId(e.target.value);
                  setTargetRegion("");
                }}
                disabled={targets === null}
              >
                <option value="">
                  {targets === null ? gt("Loading…") : gt("Choose a provider")}
                </option>
                {offered.map((t) => (
                  <option key={t.pluginId} value={t.pluginId}>
                    {t.needsAccount && !t.hasAccount
                      ? gt("{provider} (needs an account to price)", {
                          provider: gtData(t.pluginName),
                        })
                      : gtData(t.pluginName)}
                  </option>
                ))}
              </select>
            </div>
            {target && target.regions.length > 0 && (
              <div>
                <label className={labelClass} htmlFor="migration-region">
                  {gt("Region")}
                </label>
                <select
                  id="migration-region"
                  className={inputClass}
                  value={targetRegion}
                  onChange={(e) => setTargetRegion(e.target.value)}
                >
                  <option value="">{gt("Nearest to the resources")}</option>
                  {target.regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor="migration-name">
                {gt("Name")}
              </label>
              <input
                id="migration-name"
                className={inputClass}
                value={name}
                maxLength={120}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </div>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            {gt("Cancel")}
          </button>
          {!noSource && (
            <button type="submit" className={primaryClass} disabled={!canSubmit}>
              {busy ? gt("Estimating…") : gt("Estimate")}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
