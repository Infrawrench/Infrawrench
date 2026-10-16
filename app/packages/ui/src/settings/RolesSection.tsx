import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type { Dashboard, OrgRole as Role, RoleDefaultDashboard } from "@infrawrench/client-core";
import { useSettingsHost, type SettingsApi } from "./host.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

interface PermissionGroup {
  category: string;
  permissions: string[];
}

function categorize(allPermissions: string[]): PermissionGroup[] {
  const groups = new Map<string, string[]>();
  for (const p of allPermissions) {
    const category = p.split(":")[0] ?? "other";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(p);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, permissions]) => ({ category, permissions: permissions.sort() }));
}

export function RolesSection() {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api, has } = useSettingsHost();
  const canEdit = has("team:role:write");
  // A role's landing dashboard is org configuration, not role authority.
  const canSetDefaults = has("org:settings:write");

  const [roles, setRoles] = useState<Role[]>([]);
  const [allPermissions, setAllPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [roleDefaults, setRoleDefaults] = useState<Map<string, string | null>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        api.get<Role[]>(`/api/org/${orgId}/team/roles`),
        api.get<{ permissions: string[] }>(`/api/org/${orgId}/team/permissions`),
      ]);
      setRoles(r);
      setAllPermissions(c.permissions);
    } finally {
      setLoading(false);
    }
    // Default dashboards are a column on each card, not the page: a server
    // without the endpoints (or a caller without dashboards:read) just loses
    // the column.
    try {
      const [list, defaults] = await Promise.all([
        api.get<Dashboard[]>(`/api/org/${orgId}/dashboards`),
        api.get<RoleDefaultDashboard[]>(`/api/org/${orgId}/dashboards/role-defaults`),
      ]);
      setDashboards(list);
      setRoleDefaults(new Map(defaults.map((d) => [d.roleId, d.dashboardId])));
    } catch {
      setDashboards(null);
    }
  }, [api, orgId]);

  async function changeRoleDefault(role: Role, dashboardId: string) {
    setError(null);
    try {
      if (dashboardId) {
        await api.put(`/api/org/${orgId}/dashboards/role-defaults/${role.id}`, { dashboardId });
      } else {
        await api.delete(`/api/org/${orgId}/dashboards/role-defaults/${role.id}`);
      }
      setRoleDefaults((prev) => new Map(prev).set(role.id, dashboardId || null));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to set the default dashboard"));
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => categorize(allPermissions), [allPermissions]);

  async function handleDelete(role: Role) {
    if (role.isSystem) return;
    if (
      !window.confirm(gt('Delete the role "{name}"? This cannot be undone.', { name: role.name }))
    )
      return;
    setError(null);
    try {
      await api.delete(`/api/org/${orgId}/team/roles/${role.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete role"));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">{gt("Roles")}</h1>
        {canEdit && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg"
          >
            {gt("New role")}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-3">
          {roles.map((role) => (
            <div key={role.id} className="border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-on-surface">{gtData(role.name)}</h2>
                    {role.isSystem && (
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-surface-overlay text-on-surface-tertiary">
                        {gt("System")}
                      </span>
                    )}
                  </div>
                  {role.description && (
                    <p className="mt-1 text-xs text-on-surface-tertiary">
                      {gtData(role.description)}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-on-surface-muted">
                    {role.permissions.length === 1 && role.permissions[0] === "*"
                      ? gt("All permissions")
                      : gt("{count} permission{plural}", {
                          count: role.permissions.length,
                          plural: role.permissions.length === 1 ? "" : "s",
                        })}
                  </p>
                  {dashboards && (
                    <RoleDefaultDashboardPicker
                      role={role}
                      dashboards={dashboards}
                      value={roleDefaults.get(role.id) ?? null}
                      canEdit={canSetDefaults}
                      onChange={(id) => void changeRoleDefault(role, id)}
                    />
                  )}
                </div>
                {canEdit && !role.isSystem && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(role)}
                      className="text-xs text-on-surface-tertiary hover:text-on-surface"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(role)}
                      className="text-xs text-danger hover:text-danger-strong"
                    >
                      {gt("Delete")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <RoleEditor
          role={editing}
          api={api}
          orgId={orgId}
          groups={groups}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

/**
 * Where members holding `role` land when they have not picked their own
 * default. Empty means the organization default. The server refuses a
 * dashboard the role cannot see, and the section shows that message.
 */
function RoleDefaultDashboardPicker({
  role,
  dashboards,
  value,
  canEdit,
  onChange,
}: {
  role: Role;
  dashboards: Dashboard[];
  value: string | null;
  canEdit: boolean;
  onChange: (dashboardId: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const orgDefault = dashboards.find((d) => d.isDefault);
  const current = value ? dashboards.find((d) => d.id === value) : null;
  const id = `role-default-dashboard-${role.id}`;
  const fallbackLabel = orgDefault
    ? gt("Organization default ({name})", { name: orgDefault.name })
    : gt("Organization default");

  if (!canEdit) {
    return (
      <p className="mt-1 text-xs text-on-surface-muted">
        {gt("Default dashboard: {name}", { name: current ? current.name : fallbackLabel })}
      </p>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-on-surface-muted">
        {gt("Default dashboard")}
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label={gt("Default dashboard for {role}", { role: gtData(role.name) })}
        className="rounded-md border border-border bg-surface-sunken px-2 py-1 text-xs text-on-surface"
      >
        <option value="">{fallbackLabel}</option>
        {/* A default that is no longer listed (unshared from you) still shows, so saving is not a silent change. */}
        {value && !current && <option value={value}>{gt("A dashboard you cannot see")}</option>}
        {dashboards.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

interface RoleEditorProps {
  role: Role | null;
  api: SettingsApi;
  orgId: string;
  groups: PermissionGroup[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}

function RoleEditor({ role, api, orgId, groups, onClose, onSaved, onError }: RoleEditorProps) {
  const gt = useGT();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<Set<string>>(
    () => new Set(role?.permissions ?? []),
  );
  const [extraInput, setExtraInput] = useState("");
  const [saving, setSaving] = useState(false);

  function toggle(p: string) {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function addExtra() {
    const trimmed = extraInput.trim();
    if (!trimmed) return;
    setPermissions((prev) => new Set(prev).add(trimmed));
    setExtraInput("");
  }

  async function save() {
    if (!name.trim()) {
      onError(gt("Name is required"));
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissions: [...permissions],
      };
      if (role) {
        await api.patch(`/api/org/${orgId}/team/roles/${role.id}`, body);
      } else {
        await api.post(`/api/org/${orgId}/team/roles`, body);
      }
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : gt("Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  const wildcardEntries = [...permissions].filter(
    (p) => !groups.some((g) => g.permissions.includes(p)),
  );

  return (
    <Modal
      onClose={onClose}
      ariaLabel={role ? gt("Edit role: {name}", { name: role.name }) : gt("New role")}
    >
      <div className="bg-surface w-[min(48rem,92vw)] max-h-[90vh] overflow-auto rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">
            {role ? gt("Edit role: {name}", { name: role.name }) : gt("New role")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close")}
            className="text-on-surface-tertiary hover:text-on-surface"
          >
            {gt("Close")}
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label
              id="role-name-label"
              htmlFor="role-name"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              {gt("Name")}
            </label>
            <input
              id="role-name"
              aria-labelledby="role-name-label"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label
              id="role-description-label"
              htmlFor="role-description"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              {gt("Description")}
            </label>
            <input
              id="role-description"
              aria-labelledby="role-description-label"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <span className="block text-xs text-on-surface-tertiary mb-2">{gt("Permissions")}</span>
            <div className="space-y-3 max-h-80 overflow-auto pr-2">
              {groups.map((g) => (
                <div key={g.category}>
                  <h3 className="text-[11px] uppercase tracking-wider text-on-surface-muted mb-1">
                    {g.category}
                  </h3>
                  <div className="grid grid-cols-2 gap-1">
                    {g.permissions.map((p) => (
                      <label
                        key={p}
                        className="flex items-center gap-2 text-xs text-on-surface-secondary"
                      >
                        <input
                          type="checkbox"
                          checked={permissions.has(p)}
                          onChange={() => toggle(p)}
                          aria-label={p}
                        />
                        <code>{p}</code>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label
              id="role-extra-permission-label"
              htmlFor="role-extra-permission"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              {gt("Wildcard or custom permission")}
            </label>
            <div className="flex gap-2">
              <input
                id="role-extra-permission"
                aria-labelledby="role-extra-permission-label"
                value={extraInput}
                onChange={(e) => setExtraInput(e.target.value)}
                placeholder={gt("e.g. resources:*:read or *")}
                className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm font-mono"
              />
              <button
                type="button"
                onClick={addExtra}
                className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-surface-raised border border-border-strong rounded-lg"
              >
                {gt("Add")}
              </button>
            </div>
            {wildcardEntries.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {wildcardEntries.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-overlay text-xs font-mono"
                  >
                    {p}
                    <button
                      type="button"
                      onClick={() => toggle(p)}
                      aria-label={gt("Remove permission {permission}", { permission: p })}
                      title={gt("Remove permission {permission}", { permission: p })}
                      className="text-on-surface-tertiary hover:text-on-surface"
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm border border-border-strong rounded-lg text-on-surface-tertiary"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg"
            >
              {saving ? gt("Saving...") : gt("Save")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
