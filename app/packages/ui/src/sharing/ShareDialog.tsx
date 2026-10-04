import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  canShareObject,
  type ObjectAccessLevel,
  type ObjectSharing,
  type ObjectSharingInput,
  type OrgAccessLevel,
  type ShareableObjectType,
  type SharingGrantPrincipalKind,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";

/** One person or role the dialog can grant to. */
export interface SharingPrincipalOption {
  id: string;
  label: string;
}

/**
 * Transport for the share dialog, injected by each host: web over `apiFetch`,
 * desktop over the allowlisted `cloud_settings_request` IPC channel. Same
 * contract on both so the dialog itself is one component.
 */
export interface SharingClient {
  get(objectType: ShareableObjectType, objectId: string): Promise<ObjectSharing>;
  put(
    objectType: ShareableObjectType,
    objectId: string,
    input: ObjectSharingInput,
  ): Promise<ObjectSharing>;
  listMembers(): Promise<SharingPrincipalOption[]>;
  listRoles(): Promise<SharingPrincipalOption[]>;
}

export interface ShareTarget {
  objectType: ShareableObjectType;
  objectId: string;
  name: string;
}

type DraftGrant = ObjectSharingInput["grants"][number] & { label: string };

const SELECT =
  "bg-surface-overlay border border-border-strong rounded-lg px-2 py-1.5 text-sm text-on-surface-secondary focus:outline-none";

/**
 * Share a cost report, report folder or dashboard: who in the org can open
 * or edit it. Owners change sharing; everyone else sees it read-only, so
 * "why can't Sam see this?" can be answered by anyone who can open it.
 */
export function ShareDialog({
  client,
  target,
  onClose,
  onSaved,
}: {
  client: SharingClient;
  target: ShareTarget;
  onClose: () => void;
  onSaved?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [sharing, setSharing] = useState<ObjectSharing | null>(null);
  const [members, setMembers] = useState<SharingPrincipalOption[]>([]);
  const [roles, setRoles] = useState<SharingPrincipalOption[]>([]);
  const [orgAccess, setOrgAccess] = useState<OrgAccessLevel>("editor");
  const [grants, setGrants] = useState<DraftGrant[]>([]);
  const [addKind, setAddKind] = useState<SharingGrantPrincipalKind>("member");
  const [addId, setAddId] = useState("");
  const [addLevel, setAddLevel] = useState<ObjectAccessLevel>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [doc, memberRows, roleRows] = await Promise.all([
          client.get(target.objectType, target.objectId),
          client.listMembers().catch(() => [] as SharingPrincipalOption[]),
          client.listRoles().catch(() => [] as SharingPrincipalOption[]),
        ]);
        if (cancelled) return;
        setSharing(doc);
        setMembers(memberRows);
        setRoles(roleRows);
        setOrgAccess(doc.orgAccess);
        setGrants(
          doc.grants
            .filter((g) => !g.implicit)
            .map((g) => ({
              principalKind: g.principalKind,
              principalId: g.principalId,
              level: g.level,
              label: g.principalLabel ?? g.principalId,
            })),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : gt("Failed to load sharing"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, target.objectType, target.objectId, gt]);

  const canEdit = sharing ? canShareObject(sharing.callerLevel) : false;
  const options = useMemo(() => {
    const taken = new Set(
      grants.filter((g) => g.principalKind === addKind).map((g) => g.principalId),
    );
    return (addKind === "member" ? members : roles).filter((o) => !taken.has(o.id));
  }, [addKind, grants, members, roles]);

  const typeLabel =
    target.objectType === "dashboard"
      ? gt("dashboard")
      : target.objectType === "cost_report_folder"
        ? gt("folder")
        : gt("report");

  const levelLabel = (level: ObjectAccessLevel) =>
    level === "owner" ? gt("Owner") : level === "editor" ? gt("Can edit") : gt("Can view");

  function addGrant() {
    const option = options.find((o) => o.id === addId);
    if (!option) return;
    setGrants([
      ...grants,
      { principalKind: addKind, principalId: option.id, level: addLevel, label: option.label },
    ]);
    setAddId("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const doc = await client.put(target.objectType, target.objectId, {
        orgAccess,
        grants: grants.map(({ principalKind, principalId, level }) => ({
          principalKind,
          principalId,
          level,
        })),
      });
      setSharing(doc);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save sharing"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={gt("Share {name}", { name: target.name })}
      className="w-full max-w-lg"
    >
      <div className="p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-on-surface">
            {gt("Share {name}", { name: target.name })}
          </h2>
          <p className="text-xs text-on-surface-faint mt-1">
            {gt(
              "Sharing decides who can open or edit this {type}. It never goes beyond someone's role: editing still needs cost or dashboard write permission.",
              { type: typeLabel },
            )}
          </p>
        </div>

        {error && (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        )}

        {!sharing ? (
          !error && <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-on-surface-secondary">
                {gt("Everyone in the organization")}
              </span>
              <select
                className={SELECT}
                value={orgAccess}
                disabled={!canEdit}
                onChange={(e) => setOrgAccess(e.target.value as OrgAccessLevel)}
              >
                <option value="editor">{gt("Can edit")}</option>
                <option value="viewer">{gt("Can view")}</option>
                <option value="none">{gt("No access")}</option>
              </select>
            </label>

            <ul className="flex flex-col divide-y divide-border/50 border border-border rounded-lg">
              {grants.length === 0 && (
                <li className="px-3 py-2 text-xs text-on-surface-faint">
                  {gt("No one has been added individually.")}
                </li>
              )}
              {grants.map((g, i) => (
                <li
                  key={`${g.principalKind}:${g.principalId}`}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <span className="text-xs text-on-surface-faint w-14 shrink-0">
                    {g.principalKind === "member" ? gt("Member") : gt("Role")}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm text-on-surface-secondary">
                    {g.label}
                  </span>
                  <select
                    className={SELECT}
                    value={g.level}
                    disabled={!canEdit}
                    aria-label={gt("Access for {name}", { name: g.label })}
                    onChange={(e) =>
                      setGrants(
                        grants.map((x, j) =>
                          j === i ? { ...x, level: e.target.value as ObjectAccessLevel } : x,
                        ),
                      )
                    }
                  >
                    <option value="owner">{levelLabel("owner")}</option>
                    <option value="editor">{levelLabel("editor")}</option>
                    <option value="viewer">{levelLabel("viewer")}</option>
                  </select>
                  {canEdit && (
                    <button
                      type="button"
                      className="text-xs text-danger hover:text-danger-strong"
                      onClick={() => setGrants(grants.filter((_, j) => j !== i))}
                    >
                      {gt("Remove")}
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className={SELECT}
                  value={addKind}
                  aria-label={gt("Add a member or a role")}
                  onChange={(e) => {
                    setAddKind(e.target.value as SharingGrantPrincipalKind);
                    setAddId("");
                  }}
                >
                  <option value="member">{gt("Member")}</option>
                  <option value="role">{gt("Role")}</option>
                </select>
                <select
                  className={`${SELECT} flex-1 min-w-40`}
                  value={addId}
                  aria-label={gt("Who")}
                  onChange={(e) => setAddId(e.target.value)}
                >
                  <option value="">{gt("Choose…")}</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  className={SELECT}
                  value={addLevel}
                  aria-label={gt("Access level")}
                  onChange={(e) => setAddLevel(e.target.value as ObjectAccessLevel)}
                >
                  <option value="viewer">{levelLabel("viewer")}</option>
                  <option value="editor">{levelLabel("editor")}</option>
                  <option value="owner">{levelLabel("owner")}</option>
                </select>
                <button
                  type="button"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-border-strong disabled:opacity-50"
                  disabled={!addId}
                  onClick={addGrant}
                >
                  {gt("Add")}
                </button>
              </div>
            )}

            {sharing.inheritedFrom && (
              <p className="text-xs text-on-surface-faint">
                {gt("Also shared through the folder {folder}.", {
                  folder: sharing.inheritedFrom.folderName,
                })}
              </p>
            )}
            {!canEdit && (
              <p className="text-xs text-on-surface-faint">
                {gt("Only an owner of this {type} can change who it is shared with.", {
                  type: typeLabel,
                })}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-border-strong"
                onClick={onClose}
              >
                {canEdit ? gt("Cancel") : gt("Close")}
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? gt("Saving…") : gt("Save")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Build a {@link SharingClient} from any JSON transport that speaks the org
 * API paths: the web host passes `apiFetch`-backed methods, the desktop host
 * its settings IPC request. Members and roles come from the Team routes.
 */
export function createSharingClient(
  orgId: string,
  http: {
    get<T>(path: string): Promise<T>;
    put<T>(path: string, body: unknown): Promise<T>;
  },
): SharingClient {
  const base = `/api/org/${orgId}`;
  return {
    get: (type, id) => http.get<ObjectSharing>(`${base}/sharing/${type}/${encodeURIComponent(id)}`),
    put: (type, id, input) =>
      http.put<ObjectSharing>(`${base}/sharing/${type}/${encodeURIComponent(id)}`, input),
    listMembers: async () => {
      const rows = await http.get<Array<{ id: string; email: string; displayName: string | null }>>(
        `${base}/team/members`,
      );
      return rows.map((m) => ({
        id: m.id,
        label: m.displayName ? `${m.displayName} (${m.email})` : m.email,
      }));
    },
    listRoles: async () => {
      const rows = await http.get<Array<{ id: string; name: string }>>(`${base}/team/roles`);
      return rows.map((r) => ({ id: r.id, label: r.name }));
    },
  };
}
