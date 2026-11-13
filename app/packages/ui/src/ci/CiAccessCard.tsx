import { useEffect, useId, useState } from "react";
import { useGT } from "gt-react";
import {
  CI_GRANT_NAME,
  ciGrantNameFor,
  type CiAccessOverview,
  type CiConnectionAccess,
  type CiResourceGrant,
  type CiResourceOutputs,
  type SearchResult,
} from "@infrawrench/client-core";
import { ChevronIcon, SearchIcon } from "../components/icons/ChromeIcons.js";
import { ResourceTypeIcon } from "../components/icons/ResourceTypeIcon.js";
import { useDataString } from "../i18n/data-strings.js";
import { INPUT, LABEL } from "../settings/styles.js";
import { Chip, PluginLogo, ScopeFields, errorText, scopeSummary } from "./ci-access-parts.js";
import { CiConnectionsModal } from "./CiConnectionsModal.js";
import type { CiClient, CiGrantInput } from "./types.js";

const SMALL_BUTTON =
  "rounded-md border border-border px-2.5 py-1 text-xs text-on-surface transition-colors hover:bg-surface-overlay";
const ROWS = "divide-y divide-border overflow-hidden rounded-lg border border-border";

/** One connection CI may use, in a line: what it does for CI and where. */
function ConnectionSummary({
  connection,
  logo,
  onOpen,
}: {
  connection: CiConnectionAccess;
  logo: string | undefined;
  onOpen: () => void;
}) {
  const gt = useGT();
  const data = useDataString();
  const s = connection.settings;
  const kindLabels = (connection.executor?.kinds ?? [])
    .filter((k) => s.jobKinds.includes(k.kind))
    .map((k) => data(k.label));
  const scopes = [
    ...new Set([
      ...(s.jobsEnabled ? [scopeSummary(gt, s.jobRepos, s.jobBranchPattern)] : []),
      ...(s.lendEnabled ? [scopeSummary(gt, s.lendRepos, s.lendBranchPattern)] : []),
    ]),
  ];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-overlay/60"
      >
        <PluginLogo svg={logo} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
          <span className="min-w-0 sm:w-52 sm:flex-shrink-0">
            <span className="block truncate text-sm font-medium text-on-surface">
              {connection.accountName}
            </span>
            <span className="block truncate text-xs text-on-surface-faint">
              {connection.pluginName}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {s.jobsEnabled ? (
              kindLabels.length > 0 ? (
                <Chip tone="on">
                  {gt("Runs jobs")}
                  <span className="opacity-80">{` · ${kindLabels.join(", ")}`}</span>
                </Chip>
              ) : (
                <Chip tone="warning">{gt("Runs jobs · no kind chosen")}</Chip>
              )
            ) : null}
            {s.lendEnabled ? <Chip tone="on">{gt("Lends credentials")}</Chip> : null}
            {scopes.map((scope) => (
              <Chip key={scope}>{scope}</Chip>
            ))}
          </span>
        </span>
        <ChevronIcon direction="right" size={14} className="flex-shrink-0 text-on-surface-faint" />
      </button>
    </li>
  );
}

/** The resource search a grant starts from: one wide field, the hits below it. */
function ResourceSearch({
  client,
  query,
  onQuery,
  onPick,
  onError,
}: {
  client: CiClient;
  query: string;
  onQuery: (q: string) => void;
  onPick: (hit: SearchResult) => void;
  onError: (message: string) => void;
}) {
  const gt = useGT();
  const data = useDataString();
  const [hits, setHits] = useState<SearchResult[] | null>(null);
  const searchFailed = gt("Could not search resources");
  const q = query.trim();

  useEffect(() => {
    setHits(null);
    if (q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      client
        .searchResources(q)
        .then((h) => !cancelled && setHits(h.filter((r) => r.accountId !== "").slice(0, 20)))
        .catch((e) => !cancelled && onError(errorText(e, searchFailed)));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [client, q, searchFailed, onError]);

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <SearchIcon
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-on-surface-faint"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") {
              e.stopPropagation();
              onQuery("");
            }
          }}
          placeholder={gt("Search for resources")}
          aria-label={gt("Search for resources")}
          className="w-full rounded-lg border border-border-strong bg-surface py-2.5 pr-3 pl-10 text-sm text-on-surface placeholder:text-on-surface-faint [&::-webkit-search-cancel-button]:appearance-none"
          autoComplete="off"
        />
      </div>
      {q.length >= 2 ? (
        hits === null ? (
          <p role="status" className="px-1 text-xs text-on-surface-faint">
            {gt("Searching…")}
          </p>
        ) : hits.length === 0 ? (
          <p className="px-1 text-xs text-on-surface-muted">{gt("No resource matches.")}</p>
        ) : (
          <ul
            aria-label={gt("Resources")}
            className={`${ROWS} max-h-72 overflow-y-auto bg-surface-raised`}
          >
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => onPick(h)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-overlay"
                >
                  <PluginLogo svg={h.pluginLogoSvg || undefined} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-on-surface">{h.displayName}</span>
                    <span className="block truncate text-xs text-on-surface-faint">
                      {data(h.resourceTypeLabel)} · {h.accountName}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** The resource a grant is for, as the form shows it. */
interface GrantTarget {
  resourceId: string;
  name: string;
  detail: string;
  logo: string | undefined;
}

function GrantForm({
  client,
  allRepos,
  target,
  editing,
  onChooseAnother,
  onDone,
}: {
  client: CiClient;
  allRepos: string[];
  target: GrantTarget;
  /** The grant being changed; null for a new one. */
  editing: CiResourceGrant | null;
  onChooseAnother: () => void;
  onDone: (changed: boolean) => void;
}) {
  const gt = useGT();
  const data = useDataString();
  const id = useId();
  const [outputs, setOutputs] = useState<CiResourceOutputs | null>(null);
  const [input, setInput] = useState<CiGrantInput>(
    editing
      ? {
          resourceId: editing.resourceId,
          ciName: editing.ciName,
          outputs: editing.outputs,
          secretVersion: editing.secretVersion,
          repos: editing.repos,
          branchPattern: editing.branchPattern,
        }
      : {
          resourceId: target.resourceId,
          ciName: ciGrantNameFor(target.name),
          outputs: [],
          secretVersion: null,
          repos: null,
          branchPattern: null,
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outputsFailed = gt("Could not read the resource's outputs");

  useEffect(() => {
    setOutputs(null);
    let cancelled = false;
    client
      .resourceOutputs(target.resourceId)
      .then((o) => {
        if (cancelled) return;
        setOutputs(o);
        // A new grant starts with the outputs that are not sensitive ticked.
        if (!editing) {
          setInput((i) => ({
            ...i,
            outputs: o.outputs.filter((x) => !x.sensitive).map((x) => x.key),
          }));
        }
      })
      .catch((e) => !cancelled && setError(errorText(e, outputsFailed)));
    return () => {
      cancelled = true;
    };
  }, [client, target.resourceId, editing, outputsFailed]);

  const nameOk = CI_GRANT_NAME.test(input.ciName);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) await client.updateGrant(editing.id, input);
      else await client.createGrant(input);
      onDone(true);
    } catch (e) {
      setError(errorText(e, gt("Could not save")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label={editing ? gt("Edit the grant") : gt("Grant a resource")}
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-3">
        <PluginLogo svg={target.logo} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-on-surface">{target.name}</p>
          <p className="truncate text-xs text-on-surface-faint">{target.detail}</p>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={onChooseAnother}
            className="flex-shrink-0 text-xs text-accent hover:underline"
          >
            {gt("Choose another")}
          </button>
        ) : null}
      </div>

      {outputs === null && !error ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : null}
      {outputs ? (
        <>
          <div role="group" aria-labelledby={`${id}-outputs`}>
            <span id={`${id}-outputs`} className={LABEL}>
              {gt("Outputs jobs may read")}
            </span>
            {outputs.outputs.length === 0 ? (
              <p className="text-xs text-on-surface-muted">{gt("This resource has no outputs.")}</p>
            ) : (
              <div className="grid gap-x-4 gap-y-1.5 rounded-lg border border-border p-2.5 sm:grid-cols-2">
                {outputs.outputs.map((o) => (
                  <label key={o.key} className="flex min-w-0 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={input.outputs.includes(o.key)}
                      onChange={(e) =>
                        setInput((i) => ({
                          ...i,
                          outputs: e.target.checked
                            ? [...i.outputs, o.key]
                            : i.outputs.filter((x) => x !== o.key),
                        }))
                      }
                    />
                    <span className="truncate text-on-surface">{data(o.label)}</span>
                    <span className="truncate font-mono text-on-surface-faint">{o.key}</span>
                    {o.sensitive ? <span className="text-warning">{gt("sensitive")}</span> : null}
                  </label>
                ))}
              </div>
            )}
          </div>
          {outputs.secretVersions !== null ? (
            <div>
              <label htmlFor={`${id}-secret`} className={LABEL}>
                {gt("Secret value (read as the output value)")}
              </label>
              <select
                id={`${id}-secret`}
                value={input.secretVersion ?? ""}
                onChange={(e) =>
                  setInput((i) => ({
                    ...i,
                    secretVersion: e.target.value === "" ? null : e.target.value,
                  }))
                }
                className={INPUT}
              >
                <option value="">{gt("Not granted")}</option>
                <option value="latest">{gt("The latest enabled version")}</option>
                {outputs.secretVersions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {gt("Version {id} ({state})", { id: v.id, state: v.state })}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label htmlFor={`${id}-name`} className={LABEL}>
              {gt("Name in pipelines")}
            </label>
            <input
              id={`${id}-name`}
              value={input.ciName}
              onChange={(e) => setInput((i) => ({ ...i, ciName: e.target.value }))}
              className={`${INPUT} font-mono`}
              aria-invalid={input.ciName !== "" && !nameOk}
              autoComplete="off"
            />
            {nameOk ? (
              <p className="mt-1 font-mono text-[11px] text-on-surface-faint">
                {`\${{ resources.${input.ciName}.<output> }}`}
              </p>
            ) : input.ciName !== "" ? (
              <p className="mt-1 text-[11px] text-danger">
                {gt("Letters, digits, - and _, starting with a letter or digit.")}
              </p>
            ) : null}
          </div>
          <ScopeFields
            repos={input.repos}
            allRepos={allRepos}
            branchPattern={input.branchPattern}
            onChange={(repos, branchPattern) => setInput((i) => ({ ...i, repos, branchPattern }))}
          />
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="submit"
          disabled={busy || !nameOk || (input.outputs.length === 0 && !input.secretVersion)}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {editing ? gt("Save") : gt("Grant")}
        </button>
        <button
          type="button"
          onClick={() => onDone(false)}
          className="rounded-md px-3 py-1.5 text-xs text-on-surface-muted transition-colors hover:text-on-surface"
        >
          {gt("Cancel")}
        </button>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** The heading of one of the card's three parts, with its action on the right. */
function PartHeading({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <h4 className="text-xs font-semibold text-on-surface-muted">{children}</h4>
      {action}
    </div>
  );
}

/**
 * What CI jobs may use: per connection, running jobs on it and lending its
 * credentials (a line each here, their settings in a dialog); resources
 * granted one by one; SSH keys their owners lend.
 */
export function CiAccessCard({
  client,
  canManage,
  canNarrow,
}: {
  client: CiClient;
  /** `ci-access:write`: lend connections, grant resources, run cloud jobs. */
  canManage: boolean;
  /** `ci:write`: remove a grant or revoke a lent SSH key (only ever narrows). */
  canNarrow: boolean;
}) {
  const gt = useGT();
  const data = useDataString();
  const loadFailed = gt("Failed to load CI access");
  const [overview, setOverview] = useState<CiAccessOverview | null>(null);
  const [allRepos, setAllRepos] = useState<string[]>([]);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // The connections dialog: closed, or open on a connection (null: the first).
  const [managing, setManaging] = useState<{ accountId: string | null } | null>(null);
  const [query, setQuery] = useState("");
  const [granting, setGranting] = useState<{
    target: GrantTarget;
    editing: CiResourceGrant | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .access()
      .then((o) => !cancelled && setOverview(o))
      .catch((e) => !cancelled && setError(errorText(e, loadFailed)));
    client
      .listAllRepos()
      .then((r) => !cancelled && setAllRepos(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, nonce, loadFailed]);

  useEffect(() => {
    let cancelled = false;
    client
      .pluginLogos?.()
      .then((l) => !cancelled && setLogos(l))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  const replace = (c: CiConnectionAccess) =>
    setOverview((o) =>
      o
        ? { ...o, connections: o.connections.map((x) => (x.accountId === c.accountId ? c : x)) }
        : o,
    );
  const removeGrant = async (g: CiResourceGrant) => {
    try {
      await client.deleteGrant(g.id);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(errorText(e, gt("Could not remove it")));
    }
  };
  const revoke = async (sshKeyId: string) => {
    try {
      await client.revokeSshKeyLending(sshKeyId);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(errorText(e, gt("Could not revoke it")));
    }
  };

  const active = overview?.connections.filter(
    (c) => c.settings.jobsEnabled || c.settings.lendEnabled,
  );

  return (
    <section
      className="space-y-4 rounded border border-border bg-surface-raised p-4"
      aria-labelledby="ci-access"
    >
      <h3 id="ci-access" className="text-sm font-semibold text-on-surface">
        {gt("CI access")}
      </h3>
      {overview === null && !error ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : null}
      {overview && active ? (
        <>
          <div className="space-y-2">
            <PartHeading
              action={
                overview.connections.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setManaging({ accountId: null })}
                    className={SMALL_BUTTON}
                  >
                    {canManage ? gt("Manage connections") : gt("View connections")}
                  </button>
                ) : null
              }
            >
              {gt("Connections")}
            </PartHeading>
            {overview.connections.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("No connection's provider can run CI jobs or lend credentials yet.")}
              </p>
            ) : active.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("No connection runs jobs or lends its credentials yet.")}
              </p>
            ) : (
              <ul className={ROWS}>
                {active.map((c) => (
                  <ConnectionSummary
                    key={c.accountId}
                    connection={c}
                    logo={logos[c.pluginId]}
                    onOpen={() => setManaging({ accountId: c.accountId })}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <PartHeading>{gt("Resources jobs may read")}</PartHeading>
            {canManage && granting === null ? (
              <ResourceSearch
                client={client}
                query={query}
                onQuery={setQuery}
                onError={setError}
                onPick={(hit) =>
                  setGranting({
                    target: {
                      resourceId: hit.id,
                      name: hit.displayName,
                      detail: `${data(hit.resourceTypeLabel)} · ${hit.accountName}`,
                      logo: hit.pluginLogoSvg || undefined,
                    },
                    editing: null,
                  })
                }
              />
            ) : null}
            {granting !== null ? (
              <GrantForm
                key={granting.editing?.id ?? granting.target.resourceId}
                client={client}
                allRepos={allRepos}
                target={granting.target}
                editing={granting.editing}
                onChooseAnother={() => setGranting(null)}
                onDone={(changed) => {
                  setGranting(null);
                  setQuery("");
                  if (changed) setNonce((n) => n + 1);
                }}
              />
            ) : null}
            {overview.grants.length === 0 ? (
              <p className="text-xs text-on-surface-muted">{gt("No resource is granted.")}</p>
            ) : (
              <ul aria-label={gt("Granted resources")} className={ROWS}>
                {overview.grants.map((g) => (
                  <li key={g.id} className="flex items-center gap-3 px-3 py-2">
                    <PluginLogo svg={logos[g.pluginId]} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs">
                        <span className="font-mono text-on-surface">{g.ciName}</span>{" "}
                        <span className="text-on-surface-muted">
                          {g.resourceName} · {g.accountName}
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-mono text-[11px] text-on-surface-faint">
                          {[...g.outputs, ...(g.secretVersion ? ["value"] : [])].join(", ")}
                        </span>
                        <Chip>{scopeSummary(gt, g.repos, g.branchPattern)}</Chip>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-3 text-xs">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() =>
                            setGranting({
                              target: {
                                resourceId: g.resourceId,
                                name: g.resourceName,
                                detail: g.accountName,
                                logo: logos[g.pluginId],
                              },
                              editing: g,
                            })
                          }
                          className="text-accent hover:underline"
                        >
                          {gt("Edit")}
                        </button>
                      ) : null}
                      {canManage || canNarrow ? (
                        <button
                          type="button"
                          onClick={() => void removeGrant(g)}
                          className="text-danger hover:underline"
                        >
                          {gt("Remove")}
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <PartHeading>{gt("SSH keys lent to CI")}</PartHeading>
            {overview.sshKeys.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("No SSH key is lent. A key's owner lends it from Settings, SSH keys.")}
              </p>
            ) : (
              <ul aria-label={gt("SSH keys lent to CI")} className={ROWS}>
                {overview.sshKeys.map((k) => (
                  <li key={k.sshKeyId} className="flex items-center gap-3 px-3 py-2">
                    <PluginLogo
                      svg={undefined}
                      size="sm"
                      fallback={<ResourceTypeIcon iconKey="key" size={13} />}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs">
                        <span className="font-mono text-on-surface">{k.ciName}</span>{" "}
                        <span className="text-on-surface-muted">
                          {k.ownerName ? `${k.keyName} · ${k.ownerName}` : k.keyName}
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Chip>{scopeSummary(gt, k.repos, k.branchPattern)}</Chip>
                      </div>
                    </div>
                    {canNarrow || canManage ? (
                      <button
                        type="button"
                        onClick={() => void revoke(k.sshKeyId)}
                        className="flex-shrink-0 text-xs text-danger hover:underline"
                      >
                        {gt("Revoke")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {overview && managing ? (
        <CiConnectionsModal
          connections={overview.connections}
          allRepos={allRepos}
          logos={logos}
          canWrite={canManage}
          client={client}
          initialAccountId={managing.accountId}
          onSaved={replace}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </section>
  );
}
