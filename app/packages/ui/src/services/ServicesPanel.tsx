import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  SERVICE_TIERS,
  type Scorecard,
  type Service,
  type ServiceDetailResponse,
  type ServiceScorecardsResponse,
  type ServiceSummaryResponse,
} from "@infrawrench/client-core";
import { ServiceDetailView, type ServiceResourceRef } from "./ServiceDetail.js";
import { ServiceEditorModal } from "./ServiceEditorModal.js";
import { ScorecardsView } from "./ScorecardsView.js";
import {
  ScoreBadge,
  errorMessage,
  inputClass,
  labelClass,
  primaryButtonClass,
  levelColor,
  useTierLabel,
} from "./shared.js";
import type { ServicesClient } from "./types.js";

/** Where the panel is: a service's detail, the scorecards view, or the list. */
export interface ServicesPanelLocation {
  serviceId?: string | undefined;
  view?: "scorecards" | undefined;
}

export interface ServicesPanelProps {
  client: ServicesClient;
  /** The service whose detail is open; undefined shows the list (or the scorecards view). */
  serviceId?: string | undefined;
  /** "scorecards" shows the matrix and scorecard management. */
  view?: "scorecards" | undefined;
  /** Move to another place in the panel. Hosts mirror it into the URL. */
  onNavigate: (location: ServicesPanelLocation) => void;
  /** Open a member resource in the host's own resource surface. */
  onOpenResource?: ((ref: ServiceResourceRef) => void) | undefined;
}

function ServiceRow({
  service,
  scorecards,
  onOpen,
}: {
  service: Service;
  scorecards: Scorecard[] | null;
  onOpen: () => void;
}) {
  const gt = useGT();
  const tierLabel = useTierLabel();
  const owners = [
    service.ownerTeam,
    ...service.owners.map((o) => o.name ?? o.email ?? o.userId),
  ].filter((v): v is string => !!v);
  return (
    <li className="rounded-xl border border-border bg-surface-raised">
      <button type="button" onClick={onOpen} className="w-full text-left px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-on-surface truncate">{service.name}</span>
          <span className="text-xs text-on-surface-secondary">{tierLabel(service.tier)}</span>
          <span className="ml-auto text-xs text-on-surface-faint tabular-nums">
            {gt("{count} members", { count: service.memberCount })}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-on-surface-faint truncate">
          {owners.length > 0
            ? gt("Owned by {owners}", { owners: owners.join(", ") })
            : gt("No owner")}
          {service.onCallScheduleName
            ? ` · ${gt("On call: {schedule}", { schedule: service.onCallScheduleName })}`
            : ""}
        </p>
        {service.scores.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {service.scores.map((s) => (
              <ScoreBadge
                key={s.scorecardId}
                label={service.scores.length > 1 ? s.scorecardName : undefined}
                score={s.score}
                levelName={s.levelName}
                color={levelColor(scorecards, s.scorecardId, s.level)}
              />
            ))}
          </div>
        )}
      </button>
    </li>
  );
}

function ServiceList({
  client,
  canWrite,
  onOpen,
  onNew,
}: {
  client: ServicesClient;
  canWrite: boolean;
  onOpen: (serviceId: string) => void;
  onNew: () => void;
}) {
  const gt = useGT();
  const tierLabel = useTierLabel();
  const searchId = useId();
  const tierId = useId();
  const [services, setServices] = useState<Service[] | null>(null);
  const [scorecards, setScorecards] = useState<Scorecard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState("");

  const reload = useCallback(() => {
    setError(null);
    client
      .listServices()
      .then((list) => setServices([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => setError(errorMessage(e, gt("Failed to load services"))));
    // Only for level colours; a failure just leaves the badges uncoloured.
    client.listScorecards().then(setScorecards, () => setScorecards([]));
  }, [client, gt]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (services ?? []).filter((s) => {
      if (tier === "none" && s.tier !== null) return false;
      if (tier && tier !== "none" && String(s.tier) !== tier) return false;
      if (!q) return true;
      const haystack = [
        s.name,
        s.slug,
        s.ownerTeam ?? "",
        s.description ?? "",
        ...s.owners.map((o) => `${o.name ?? ""} ${o.email ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [services, search, tier]);

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Group resources across providers into the services they make up, with owners, SLOs, runbooks, on-call and cost in one place.",
          )}
        </p>
        {canWrite && (
          <button type="button" onClick={onNew} className={`${primaryButtonClass} shrink-0`}>
            {gt("New service")}
          </button>
        )}
      </div>

      <div className="grid grid-cols-[1fr_12rem] gap-2 mb-3">
        <div>
          <label className={labelClass} htmlFor={searchId}>
            {gt("Search")}
          </label>
          <input
            id={searchId}
            type="search"
            className={inputClass}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={gt("Name, slug, team or owner")}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={tierId}>
            {gt("Tier")}
          </label>
          <select
            id={tierId}
            className={inputClass}
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          >
            <option value="">{gt("Any tier")}</option>
            {SERVICE_TIERS.map((t) => (
              <option key={t} value={String(t)}>
                {tierLabel(t)}
              </option>
            ))}
            <option value="none">{gt("Untiered")}</option>
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={reload} className="underline">
            {gt("Retry")}
          </button>
        </p>
      )}
      {services === null && !error && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading services…")}
        </p>
      )}
      {services !== null && services.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No services yet. Create one, add the resources it is made of, and link its SLOs, runbooks and on-call schedule.",
          )}
        </p>
      )}
      {services !== null && services.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-on-surface-faint">{gt("No service matches these filters.")}</p>
      )}
      {filtered.length > 0 && (
        <ul className="space-y-2">
          {filtered.map((s) => (
            <ServiceRow
              key={s.id}
              service={s}
              scorecards={scorecards}
              onOpen={() => onOpen(s.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ServiceDetailLoader({
  client,
  serviceId,
  canWrite,
  onNavigate,
  onEdit,
  onOpenResource,
  reloadKey,
}: {
  client: ServicesClient;
  serviceId: string;
  canWrite: boolean;
  onNavigate: (location: ServicesPanelLocation) => void;
  onEdit: (service: Service) => void;
  onOpenResource?: ((ref: ServiceResourceRef) => void) | undefined;
  reloadKey: number;
}) {
  const gt = useGT();
  const [detail, setDetail] = useState<ServiceDetailResponse | null>(null);
  const [summary, setSummary] = useState<ServiceSummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [results, setResults] = useState<ServiceScorecardsResponse | null>(null);
  const [scorecards, setScorecards] = useState<Scorecard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(() => {
    setSummaryError(null);
    client
      .getServiceSummary(serviceId)
      .then(setSummary)
      .catch((e) => setSummaryError(errorMessage(e, gt("Failed to load the summary"))));
    client
      .getServiceScorecards(serviceId)
      .then(setResults)
      .catch(() => setResults({ results: [], history: {} }));
  }, [client, serviceId, gt]);

  const load = useCallback(() => {
    setError(null);
    client
      .getService(serviceId)
      .then(setDetail)
      .catch((e) => setError(errorMessage(e, gt("Failed to load the service"))));
    client.listScorecards().then(setScorecards, () => setScorecards([]));
    loadSummary();
  }, [client, serviceId, gt, loadSummary]);

  useEffect(() => {
    setDetail(null);
    setSummary(null);
    setResults(null);
    load();
  }, [load, reloadKey]);

  if (error) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onNavigate({})}
          className="text-xs text-on-surface-secondary hover:text-on-surface"
        >
          {gt("← All services")}
        </button>
        <p role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={load} className="underline">
            {gt("Retry")}
          </button>
        </p>
      </div>
    );
  }
  if (!detail) {
    return (
      <p role="status" className="text-sm text-on-surface-faint">
        {gt("Loading service…")}
      </p>
    );
  }
  return (
    <ServiceDetailView
      client={client}
      detail={detail}
      summary={summary}
      summaryError={summaryError}
      scorecardResults={results}
      scorecards={scorecards}
      canWrite={canWrite}
      onBack={() => onNavigate({})}
      onEdit={() => onEdit(detail.service)}
      onDeleted={() => onNavigate({})}
      onOpenResource={onOpenResource}
      onMembershipChanged={(next) => {
        setDetail(next);
        // Membership feeds cost, findings and the scores: refresh them too.
        loadSummary();
      }}
    />
  );
}

/**
 * Services and scorecards: the service list, one service's detail (summary,
 * members, scorecard results), and the scorecards view (the matrix and the
 * scorecards themselves). Shared between web and desktop; write actions are
 * gated on the client exposing the write methods. Where the panel is lives
 * in props the host mirrors into the URL.
 */
export function ServicesPanel({
  client,
  serviceId,
  view,
  onNavigate,
  onOpenResource,
}: ServicesPanelProps) {
  const gt = useGT();
  const [editing, setEditing] = useState<{ existing: Service | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canWrite = Boolean(client.createService && client.updateService && client.deleteService);
  const showScorecards = !serviceId && view === "scorecards";

  const tabClass = (active: boolean) =>
    `px-3 py-1 rounded-lg text-sm ${active ? "bg-surface-raised text-on-surface border border-border" : "text-on-surface-secondary hover:text-on-surface"}`;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold text-on-surface">{gt("Services")}</h1>
        <div className="flex items-center gap-1" role="group" aria-label={gt("View")}>
          <button
            type="button"
            aria-pressed={!showScorecards}
            className={tabClass(!showScorecards)}
            onClick={() => onNavigate({})}
          >
            {gt("Services")}
          </button>
          <button
            type="button"
            aria-pressed={showScorecards}
            className={tabClass(showScorecards)}
            onClick={() => onNavigate({ view: "scorecards" })}
          >
            {gt("Scorecards")}
          </button>
        </div>
      </div>

      {serviceId ? (
        <ServiceDetailLoader
          key={serviceId}
          client={client}
          serviceId={serviceId}
          canWrite={canWrite}
          onNavigate={onNavigate}
          onEdit={(service) => setEditing({ existing: service })}
          onOpenResource={onOpenResource}
          reloadKey={reloadKey}
        />
      ) : showScorecards ? (
        <ScorecardsView client={client} onOpenService={(id) => onNavigate({ serviceId: id })} />
      ) : (
        <ServiceList
          key={reloadKey}
          client={client}
          canWrite={canWrite}
          onOpen={(id) => onNavigate({ serviceId: id })}
          onNew={() => setEditing({ existing: null })}
        />
      )}

      {editing && (
        <ServiceEditorModal
          client={client}
          existing={editing.existing}
          onSaved={(saved) => {
            if (!editing.existing && saved) onNavigate({ serviceId: saved.id });
            else setReloadKey((k) => k + 1);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
