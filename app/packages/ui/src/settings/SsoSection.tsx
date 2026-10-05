import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import type {
  SsoDirectoryGroup,
  SsoDirectoryMember,
  SsoDirectoryMemberStatus,
  SsoDomain,
  SsoGroupRoleMapping,
  SsoMappingPreviewRow,
  SsoPortalIntent,
  SsoSettings,
  SsoStatus,
  SsoSyncResult,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

interface RoleOption {
  id: string;
  name: string;
  systemKey: string | null;
}

const inputClass =
  "px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
const primaryButton =
  "px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors";
const secondaryButton =
  "px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors";
const card = "border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50";

function StateBadge({ state }: { state: string }) {
  const good = state === "verified" || state === "active";
  const bad = state === "failed" || state === "inactive" || state === "invalid_credentials";
  const cls = good
    ? "text-success border-emerald-900/50 bg-emerald-950/20"
    : bad
      ? "text-danger border-red-900/50 bg-red-950/20"
      : "text-on-surface-tertiary border-border bg-surface";
  return <span className={`text-[11px] px-1.5 py-0.5 rounded border ${cls}`}>{state}</span>;
}

/**
 * Single sign-on for signing in to Infrawrench itself: SAML/OIDC through
 * WorkOS, SCIM directory sync, and directory group to role mappings.
 *
 * The identity provider and the directory are configured by the customer's
 * IT admin in the WorkOS Admin Portal, opened from here with a short-lived
 * link: nobody has to paste a metadata URL or a SCIM token into this page.
 * What this page owns is what WorkOS cannot know: which domains are enforced,
 * who may get in when the IdP is down, and what each group means here.
 */
export function SsoSection() {
  const gt = useGT();
  const { orgId, api, has, openExternal } = useSettingsHost();
  const canWrite = has("org:settings:write");

  const [status, setStatus] = useState<SsoStatus | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [groups, setGroups] = useState<SsoDirectoryGroup[]>([]);
  const [mappings, setMappings] = useState<SsoGroupRoleMapping[]>([]);
  const [members, setMembers] = useState<SsoDirectoryMember[]>([]);
  const [preview, setPreview] = useState<SsoMappingPreviewRow[] | null>(null);
  const [syncResult, setSyncResult] = useState<SsoSyncResult | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [newGroupId, setNewGroupId] = useState("");
  const [newRoleId, setNewRoleId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const base = `/api/org/${orgId}/sso`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.get<SsoStatus>(base);
      setStatus(s);
      const roleRows = await api
        .get<RoleOption[]>(`/api/org/${orgId}/team/roles`)
        .catch(() => [] as RoleOption[]);
      setRoles(roleRows);
      if (s.configured) {
        const [m, dm] = await Promise.all([
          api.get<{ mappings: SsoGroupRoleMapping[] }>(`${base}/group-mappings`),
          api.get<{ members: SsoDirectoryMember[] }>(`${base}/directory-members`),
        ]);
        setMappings(m.mappings);
        setMembers(dm.members);
        if (s.directories.length > 0) {
          api.get<{ groups: SsoDirectoryGroup[] }>(`${base}/groups`).then(
            (g) => setGroups(g.groups),
            () => setGroups([]),
          );
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load single sign-on settings"));
    } finally {
      setLoading(false);
    }
  }, [api, base, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Something went wrong"));
    } finally {
      setBusy(null);
    }
  }

  const openPortal = (intent: SsoPortalIntent) =>
    run(`portal-${intent}`, async () => {
      const { link } = await api.post<{ link: string }>(`${base}/portal-link`, { intent });
      openExternal(link);
      setNotice(
        gt(
          "The WorkOS Admin Portal opened in a new window. The link expires in five minutes; forward it to your IT admin or finish the setup yourself.",
        ),
      );
    });

  const saveSettings = (patch: Partial<SsoSettings>) =>
    run("settings", async () => {
      const saved = await api.put<SsoSettings>(`${base}/settings`, patch);
      setStatus((s) => (s ? { ...s, settings: saved } : s));
      setNotice(gt("Single sign-on settings saved."));
    });

  const assignableRoles = useMemo(() => roles.filter((r) => r.systemKey !== "owner"), [roles]);
  const unmappedGroups = groups.filter((g) => !mappings.some((m) => m.directoryGroupId === g.id));

  if (loading) return <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>;

  const settings = status?.settings ?? null;
  const verifiedCount = status?.domains.filter((d) => d.state === "verified").length ?? 0;
  const activeConnection = status?.connections.some((c) => c.state === "active") ?? false;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Single sign-on")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Let your team sign in through your identity provider (Okta, Microsoft Entra ID, Google
            Workspace, or any SAML or OIDC provider), keep membership in step with your directory
            over SCIM, and map directory groups to roles. Changes need{" "}
            <Var>
              <code>org:settings:write</code>
            </Var>
            .
          </p>
        </T>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-3 py-2 text-sm text-success border border-emerald-900/50 bg-emerald-950/20 rounded-lg">
          {notice}
        </div>
      )}
      {status?.workosError && (
        <div className="mb-4 px-3 py-2 text-sm text-warning border border-amber-900/50 bg-amber-950/20 rounded-lg">
          {gt("Could not reach WorkOS; showing saved settings only.")}
        </div>
      )}

      {!status?.planIncluded && (
        <div className="mb-4 px-3 py-2 text-sm border border-border rounded-lg text-on-surface-secondary">
          {gt("Single sign-on is available on the paid plan. Upgrade under Settings → Billing.")}
        </div>
      )}

      {status && !status.configured ? (
        <section className={card}>
          <h2 className="text-sm font-semibold">{gt("Get started")}</h2>
          <p className="text-xs text-on-surface-muted">
            {gt(
              "Setting up creates a WorkOS organization for this Infrawrench organization. Nothing changes for anyone until you connect an identity provider and choose to require it.",
            )}
          </p>
          {canWrite && (
            <button
              type="button"
              disabled={busy !== null || !status.planIncluded}
              className={primaryButton}
              onClick={() =>
                void run("setup", async () => {
                  await api.post(`${base}/setup`);
                  await load();
                })
              }
            >
              {busy === "setup" ? gt("Setting up…") : gt("Set up single sign-on")}
            </button>
          )}
        </section>
      ) : status && settings ? (
        <div className="space-y-8">
          {/* Domains */}
          <section className={card}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{gt("Domains")}</h2>
              {canWrite && (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy !== null}
                  onClick={() => void openPortal("domain_verification")}
                >
                  {gt("Let your IT admin verify")}
                </button>
              )}
            </div>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "Only verified domains are enforced and provisioned. Verify a domain by adding the DNS TXT record shown, then checking it here.",
              )}
            </p>
            {status.domains.length === 0 ? (
              <p className="text-sm text-on-surface-muted">{gt("No domains yet.")}</p>
            ) : (
              <ul className="divide-y divide-border/50 border border-border rounded-lg">
                {status.domains.map((d) => (
                  <DomainRow
                    key={d.id}
                    domain={d}
                    canWrite={canWrite}
                    busy={busy !== null}
                    onVerify={() =>
                      void run(`verify-${d.id}`, async () => {
                        const res = await api.post<SsoDomain>(`${base}/domains/${d.id}/verify`);
                        setNotice(
                          res.state === "verified"
                            ? gt("{domain} is verified.", { domain: d.domain })
                            : gt("The DNS record for {domain} was not found yet.", {
                                domain: d.domain,
                              }),
                        );
                        await load();
                      })
                    }
                    onRemove={() => {
                      if (!window.confirm(gt("Remove {domain}?", { domain: d.domain }))) return;
                      void run(`remove-${d.id}`, async () => {
                        await api.delete(`${base}/domains/${d.id}`);
                        await load();
                      });
                    }}
                  />
                ))}
              </ul>
            )}
            {canWrite && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("add-domain", async () => {
                    await api.post(`${base}/domains`, { domain: newDomain });
                    setNewDomain("");
                    await load();
                  });
                }}
              >
                <input
                  type="text"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder={gt("example.com")}
                  aria-label={gt("Domain")}
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="submit"
                  disabled={busy !== null || !newDomain}
                  className={primaryButton}
                >
                  {gt("Add domain")}
                </button>
              </form>
            )}
          </section>

          {/* Identity provider */}
          <section className={card}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{gt("Identity provider")}</h2>
              {canWrite && (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy !== null}
                  onClick={() => void openPortal("sso")}
                >
                  {status.connections.length === 0
                    ? gt("Connect an identity provider")
                    : gt("Manage connection")}
                </button>
              )}
            </div>
            {status.connections.length === 0 ? (
              <p className="text-sm text-on-surface-muted">
                {gt(
                  "No connection yet. The Admin Portal walks your IT admin through SAML or OIDC setup for their provider.",
                )}
              </p>
            ) : (
              <ul className="space-y-1">
                {status.connections.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-on-surface-muted">{c.type}</span>
                    <StateBadge state={c.state} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Enforcement */}
          <EnforcementCard
            status={status}
            settings={settings}
            canWrite={canWrite}
            busy={busy !== null}
            ready={verifiedCount > 0 && activeConnection}
            onSave={saveSettings}
          />

          {/* Directory sync */}
          <section className={card}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{gt("Directory sync (SCIM)")}</h2>
              {canWrite && (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy !== null}
                  onClick={() => void openPortal("dsync")}
                >
                  {status.directories.length === 0
                    ? gt("Connect a directory")
                    : gt("Manage directory")}
                </button>
              )}
            </div>
            {status.directories.length === 0 ? (
              <p className="text-sm text-on-surface-muted">
                {gt(
                  "No directory yet. Once connected, people added in your identity provider become members here, and people removed lose access immediately.",
                )}
              </p>
            ) : (
              <ul className="space-y-1">
                {status.directories.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{d.name}</span>
                    <span className="text-xs text-on-surface-muted">{d.type}</span>
                    <StateBadge state={d.state} />
                  </li>
                ))}
              </ul>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.provisioningEnabled}
                disabled={!canWrite || busy !== null}
                onChange={(e) => void saveSettings({ provisioningEnabled: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                {gt("Provision and deprovision members from the directory")}
                <span className="block text-xs text-on-surface-muted">
                  {gt(
                    "Off: the directory is only observed, so you can preview the mappings below before it changes who is in the organization.",
                  )}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoAddSeats}
                disabled={!canWrite || busy !== null}
                onChange={(e) => void saveSettings({ autoAddSeats: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                {gt("Add a seat when the plan is full")}
                <span className="block text-xs text-on-surface-muted">
                  {gt(
                    "Off: people past your seat count wait as “Waiting for a seat” instead of growing the bill.",
                  )}
                </span>
              </span>
            </label>
            <label className="block text-sm">
              <span className="block text-xs text-on-surface-tertiary mb-1">
                {gt("Role when no group is mapped")}
              </span>
              <select
                value={settings.defaultRoleId ?? ""}
                disabled={!canWrite || busy !== null}
                onChange={(e) => void saveSettings({ defaultRoleId: e.target.value || null })}
                className={inputClass}
              >
                <option value="">{gt("Member (default)")}</option>
                {assignableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {canWrite && status.directories.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy !== null}
                  onClick={() =>
                    void run("sync", async () => {
                      const result = await api.post<SsoSyncResult>(`${base}/sync`);
                      setSyncResult(result);
                      await load();
                    })
                  }
                >
                  {busy === "sync" ? gt("Syncing…") : gt("Sync now")}
                </button>
                {syncResult && (
                  <span className="text-xs text-on-surface-muted">
                    {gt(
                      "{seen} users seen: {added} added, {removed} removed, {changed} role changes, {skipped} skipped.",
                      {
                        seen: syncResult.usersSeen,
                        added: syncResult.provisioned,
                        removed: syncResult.deprovisioned,
                        changed: syncResult.rolesChanged,
                        skipped: syncResult.skipped,
                      },
                    )}
                  </span>
                )}
              </div>
            )}
          </section>

          {/* Group → role mappings */}
          <section className={card}>
            <h2 className="text-sm font-semibold">{gt("Group to role mappings")}</h2>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "Applied on every directory sync and at each sign-in. The first matching row wins, so order matters; anyone in no mapped group gets the default role. Owners are never changed by the directory, and no group can grant the owner role.",
              )}
            </p>
            {mappings.length === 0 ? (
              <p className="text-sm text-on-surface-muted">{gt("No mappings yet.")}</p>
            ) : (
              <ol className="divide-y divide-border/50 border border-border rounded-lg">
                {mappings.map((m, i) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="text-xs text-on-surface-faint w-5">{i + 1}</span>
                    <span className="flex-1 min-w-[8rem] font-medium">{m.groupName}</span>
                    <select
                      value={m.roleId}
                      disabled={!canWrite || busy !== null}
                      aria-label={gt("Role for {group}", { group: m.groupName })}
                      onChange={(e) =>
                        void run(`map-${m.id}`, async () => {
                          await api.patch(`${base}/group-mappings/${m.id}`, {
                            roleId: e.target.value,
                          });
                          await load();
                        })
                      }
                      className={inputClass}
                    >
                      {assignableRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    {canWrite && (
                      <>
                        <button
                          type="button"
                          className="px-2 text-on-surface-tertiary disabled:opacity-30"
                          disabled={i === 0 || busy !== null}
                          aria-label={gt("Move up")}
                          onClick={() =>
                            void run(`up-${m.id}`, async () => {
                              await reorder(api, base, mappings, i, i - 1);
                              await load();
                            })
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="px-2 text-on-surface-tertiary disabled:opacity-30"
                          disabled={i === mappings.length - 1 || busy !== null}
                          aria-label={gt("Move down")}
                          onClick={() =>
                            void run(`down-${m.id}`, async () => {
                              await reorder(api, base, mappings, i, i + 1);
                              await load();
                            })
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="text-xs text-danger hover:text-danger-strong"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(`del-${m.id}`, async () => {
                              await api.delete(`${base}/group-mappings/${m.id}`);
                              await load();
                            })
                          }
                        >
                          {gt("Remove")}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <select
                  value={newGroupId}
                  onChange={(e) => setNewGroupId(e.target.value)}
                  aria-label={gt("Directory group")}
                  className={`${inputClass} flex-1 min-w-[10rem]`}
                  disabled={unmappedGroups.length === 0}
                >
                  <option value="">
                    {groups.length === 0
                      ? gt("Connect a directory to pick groups")
                      : gt("Choose a group…")}
                  </option>
                  {unmappedGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                      {status.directories.length > 1 ? ` (${g.directoryName})` : ""}
                    </option>
                  ))}
                </select>
                <select
                  value={newRoleId}
                  onChange={(e) => setNewRoleId(e.target.value)}
                  aria-label={gt("Role")}
                  className={inputClass}
                >
                  <option value="">{gt("Choose a role…")}</option>
                  {assignableRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={primaryButton}
                  disabled={busy !== null || !newGroupId || !newRoleId}
                  onClick={() =>
                    void run("add-mapping", async () => {
                      await api.post(`${base}/group-mappings`, {
                        directoryGroupId: newGroupId,
                        roleId: newRoleId,
                      });
                      setNewGroupId("");
                      setNewRoleId("");
                      await load();
                    })
                  }
                >
                  {gt("Add mapping")}
                </button>
              </div>
            )}
            <div>
              <button
                type="button"
                className={secondaryButton}
                disabled={busy !== null}
                onClick={() =>
                  void run("preview", async () => {
                    const res = await api.post<{ rows: SsoMappingPreviewRow[] }>(
                      `${base}/group-mappings/preview`,
                      {},
                    );
                    setPreview(res.rows);
                  })
                }
              >
                {gt("Preview")}
              </button>
            </div>
            {preview && <PreviewTable rows={preview} />}
          </section>

          <DirectoryMembers members={members} />
        </div>
      ) : null}
    </div>
  );
}

/** Swap two mappings' positions, renumbering the list so positions stay distinct. */
async function reorder(
  api: ReturnType<typeof useSettingsHost>["api"],
  base: string,
  mappings: SsoGroupRoleMapping[],
  from: number,
  to: number,
) {
  const order = [...mappings];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  for (let i = 0; i < order.length; i++) {
    const m = order[i]!;
    if (m.position !== i) await api.patch(`${base}/group-mappings/${m.id}`, { position: i });
  }
}

function DomainRow({
  domain,
  canWrite,
  busy,
  onVerify,
  onRemove,
}: {
  domain: SsoDomain;
  canWrite: boolean;
  busy: boolean;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  return (
    <li className="px-3 py-2 text-sm space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-medium flex-1">{domain.domain}</span>
        <StateBadge state={domain.state} />
        {canWrite && domain.state !== "verified" && (
          <button type="button" className={secondaryButton} disabled={busy} onClick={onVerify}>
            {gt("Check DNS")}
          </button>
        )}
        {canWrite && (
          <button
            type="button"
            className="text-xs text-danger hover:text-danger-strong"
            disabled={busy}
            onClick={onRemove}
          >
            {gt("Remove")}
          </button>
        )}
      </div>
      {domain.state !== "verified" && domain.verificationToken && (
        <div className="text-xs text-on-surface-muted">
          {gt("Add a DNS TXT record:")}{" "}
          <code className="break-all">
            {domain.verificationPrefix
              ? `${domain.verificationPrefix}.${domain.domain}`
              : domain.domain}
          </code>{" "}
          = <code className="break-all">{domain.verificationToken}</code>
        </div>
      )}
    </li>
  );
}

function EnforcementCard({
  status,
  settings,
  canWrite,
  busy,
  ready,
  onSave,
}: {
  status: SsoStatus;
  settings: SsoSettings;
  canWrite: boolean;
  busy: boolean;
  ready: boolean;
  onSave: (patch: Partial<SsoSettings>) => Promise<void>;
}) {
  const gt = useGT();
  const sessionText: Record<SsoStatus["currentSession"], string> = {
    sso: gt("You are signed in through this organization's identity provider."),
    not_sso: gt(
      "You did not sign in through this organization's identity provider. Sign in again with SSO, or add yourself as a break-glass owner, before requiring it.",
    ),
    outside_domains: gt(
      "Your email is outside the verified domains, so enforcement does not apply to you.",
    ),
    break_glass_owner: gt("You are a break-glass owner and may sign in without SSO."),
    unknown: gt("Your current sign-in method could not be confirmed."),
  };
  const toggleOwner = (userId: string, on: boolean) => {
    const next = on
      ? [...settings.breakGlassUserIds, userId]
      : settings.breakGlassUserIds.filter((id) => id !== userId);
    void onSave({ breakGlassUserIds: next });
  };
  return (
    <section className={card}>
      <h2 className="text-sm font-semibold">{gt("Enforcement")}</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.enforceSso}
          disabled={!canWrite || busy || (!settings.enforceSso && !ready)}
          onChange={(e) => void onSave({ enforceSso: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          {gt("Require single sign-on for verified domains")}
          <span className="block text-xs text-on-surface-muted">
            {gt(
              "Members whose email is in a verified domain must sign in through your identity provider. Password, magic-link and social sign-ins stop working for them in this organization, including sessions that are already open. API keys are not affected.",
            )}
          </span>
          {!ready && !settings.enforceSso && (
            <span className="block text-xs text-warning">
              {gt("Verify a domain and connect an identity provider first.")}
            </span>
          )}
        </span>
      </label>
      <p className="text-xs text-on-surface-tertiary">{sessionText[status.currentSession]}</p>
      <div>
        <h3 className="text-xs font-semibold text-on-surface-secondary mb-1">
          {gt("Break-glass owners")}
        </h3>
        <p className="text-xs text-on-surface-muted mb-2">
          {gt(
            "Owners who can still sign in without SSO when your identity provider is down. At least one is required before enforcing. Every bypass is written to the audit log. Anyone else can ask for temporary access through Break-glass Access by requesting the sso:bypass permission; only owners can approve it.",
          )}
        </p>
        <ul className="space-y-1">
          {status.owners.map((o) => (
            <li key={o.userId}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.breakGlassUserIds.includes(o.userId)}
                  disabled={!canWrite || busy}
                  onChange={(e) => toggleOwner(o.userId, e.target.checked)}
                />
                <span>{o.displayName ?? o.email}</span>
                {o.displayName && <span className="text-xs text-on-surface-muted">{o.email}</span>}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PreviewTable({ rows }: { rows: SsoMappingPreviewRow[] }) {
  const gt = useGT();
  if (rows.length === 0) {
    return (
      <p className="text-sm text-on-surface-muted">
        {gt(
          "No directory members yet. Connect a directory and sync to see who the mappings would affect.",
        )}
      </p>
    );
  }
  const changes = rows.filter((r) => r.changes).length;
  const conflicts = rows.filter((r) => r.conflict).length;
  return (
    <div className="space-y-2">
      <p className="text-xs text-on-surface-muted">
        {gt("{changes} role changes, {conflicts} members in more than one mapped group.", {
          changes,
          conflicts,
        })}
      </p>
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-xs">
          <thead className="text-on-surface-tertiary">
            <tr className="text-left">
              <th className="px-3 py-1.5">{gt("Person")}</th>
              <th className="px-3 py-1.5">{gt("Groups matched")}</th>
              <th className="px-3 py-1.5">{gt("Current role")}</th>
              <th className="px-3 py-1.5">{gt("New role")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {rows.map((r) => (
              <tr key={r.email} className={r.changes ? "bg-blue-950/10" : undefined}>
                <td className="px-3 py-1.5">{r.email}</td>
                <td className="px-3 py-1.5">
                  {r.matchedGroupNames.join(", ") || "—"}
                  {r.conflict && (
                    <span className="ml-1 text-warning">{gt("(conflict: first row wins)")}</span>
                  )}
                </td>
                <td className="px-3 py-1.5">{r.currentRoleName ?? "—"}</td>
                <td className="px-3 py-1.5">
                  {r.source === "owner_unchanged"
                    ? gt("Owner (unchanged)")
                    : (r.resolvedRoleName ?? "—")}
                  {r.source === "default" && (
                    <span className="ml-1 text-on-surface-faint">{gt("(default)")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DirectoryMembers({ members }: { members: SsoDirectoryMember[] }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const labels: Record<SsoDirectoryMemberStatus, string> = {
    active: gt("Member"),
    observed: gt("Seen (provisioning off)"),
    deprovisioned: gt("Removed by directory"),
    seat_limit: gt("Waiting for a seat"),
    plan_required: gt("Plan required"),
    domain_unverified: gt("Email outside verified domains"),
    protected: gt("Kept (last owner)"),
  };
  if (members.length === 0) return null;
  return (
    <section className="space-y-2">
      <button
        type="button"
        className="text-sm font-semibold"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "▾ " : "▸ "}
        {gt("Directory members ({count})", { count: members.length })}
      </button>
      {open && (
        <ul className="border border-border rounded-xl divide-y divide-border/50">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1 truncate">{m.displayName ?? m.email}</span>
              <span className="text-xs text-on-surface-muted truncate">{m.email}</span>
              <span className="text-xs text-on-surface-tertiary shrink-0">{labels[m.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
