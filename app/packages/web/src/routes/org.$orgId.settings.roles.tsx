import { createFileRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@infrawrench/ui";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { usePermissions } from "@/auth/permissions-context";

interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  systemKey: string | null;
  permissions: string[];
}

interface PermissionGroup {
  category: string;
  permissions: string[];
}

export const Route = createFileRoute("/org/$orgId/settings/roles")({
  component: RolesPage,
});

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

function RolesPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/roles" });
  const { has } = usePermissions();
  const canEdit = has("team:role:write");

  const [roles, setRoles] = useState<Role[]>([]);
  const [allPermissions, setAllPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        apiGet<Role[]>(`/api/org/${orgId}/team/roles`),
        apiGet<{ permissions: string[] }>(`/api/org/${orgId}/team/permissions`),
      ]);
      setRoles(r);
      setAllPermissions(c.permissions);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => categorize(allPermissions), [allPermissions]);

  async function handleDelete(role: Role) {
    if (role.isSystem) return;
    if (!window.confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await apiDelete(`/api/org/${orgId}/team/roles/${role.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete role");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Roles</h1>
        {canEdit && (
          <button
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg"
          >
            New role
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading...</p>
      ) : (
        <div className="space-y-3">
          {roles.map((role) => (
            <div key={role.id} className="border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-on-surface">{role.name}</h2>
                    {role.isSystem && (
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-surface-overlay text-on-surface-tertiary">
                        System
                      </span>
                    )}
                  </div>
                  {role.description && (
                    <p className="mt-1 text-xs text-on-surface-tertiary">{role.description}</p>
                  )}
                  <p className="mt-2 text-xs text-on-surface-muted">
                    {role.permissions.length === 1 && role.permissions[0] === "*"
                      ? "All permissions"
                      : `${role.permissions.length} permission${role.permissions.length === 1 ? "" : "s"}`}
                  </p>
                </div>
                {canEdit && !role.isSystem && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditing(role)}
                      className="text-xs text-on-surface-tertiary hover:text-on-surface"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void handleDelete(role)}
                      className="text-xs text-red-400 hover:text-red-500"
                    >
                      Delete
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

interface RoleEditorProps {
  role: Role | null;
  orgId: string;
  groups: PermissionGroup[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}

function RoleEditor({ role, orgId, groups, onClose, onSaved, onError }: RoleEditorProps) {
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
      onError("Name is required");
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
        await apiPatch(`/api/org/${orgId}/team/roles/${role.id}`, body);
      } else {
        await apiPost(`/api/org/${orgId}/team/roles`, body);
      }
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const wildcardEntries = [...permissions].filter(
    (p) => !groups.some((g) => g.permissions.includes(p)),
  );

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface w-[min(48rem,92vw)] max-h-[90vh] overflow-auto rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">
            {role ? `Edit role: ${role.name}` : "New role"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-tertiary hover:text-on-surface"
          >
            Close
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-on-surface-tertiary mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-on-surface-tertiary mb-1">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs text-on-surface-tertiary mb-2">Permissions</label>
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
            <label className="block text-xs text-on-surface-tertiary mb-1">
              Wildcard or custom permission
            </label>
            <div className="flex gap-2">
              <input
                value={extraInput}
                onChange={(e) => setExtraInput(e.target.value)}
                placeholder="e.g. resources:*:read or *"
                className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={addExtra}
                className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-surface-raised border border-border-strong rounded-lg"
              >
                Add
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
                      onClick={() => toggle(p)}
                      className="text-on-surface-tertiary hover:text-on-surface"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm border border-border-strong rounded-lg text-on-surface-tertiary"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
