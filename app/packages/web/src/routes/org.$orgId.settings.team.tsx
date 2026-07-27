import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { apiGet, apiPost, apiDelete, apiPatch } from "@/lib/api";
import { Can, usePermissions } from "@/auth/permissions-context";
import type { InvitationSummary, TeamMember } from "@infrawrench/ui";

interface RoleOption {
  id: string;
  name: string;
  isSystem: boolean;
  systemKey: string | null;
}

export const Route = createFileRoute("/org/$orgId/settings/team")({
  component: TeamPage,
});

function TeamPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/team" });
  const { has } = usePermissions();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<InvitationSummary[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState<string>("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canInvite = has("team:invite");
  const canChangeRoles = has("team:role:write");
  const canRemove = has("team:remove");

  const load = useCallback(async () => {
    setLoading(true);
    const [m, i, r] = await Promise.all([
      apiGet<TeamMember[]>(`/api/org/${orgId}/team/members`),
      apiGet<InvitationSummary[]>(`/api/org/${orgId}/team/invitations`),
      apiGet<RoleOption[]>(`/api/org/${orgId}/team/roles`).catch(() => [] as RoleOption[]),
    ]);
    setMembers(m);
    setInvites(i);
    setRoles(r);
    if (!inviteRoleId) {
      const memberRole = r.find((role) => role.systemKey === "member");
      if (memberRole) setInviteRoleId(memberRole.id);
    }
    setLoading(false);
  }, [orgId, inviteRoleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite() {
    if (!inviteEmail.trim() || !inviteRoleId) return;
    setInviting(true);
    setError(null);
    try {
      await apiPost(`/api/org/${orgId}/team/invitations`, {
        email: inviteEmail.trim(),
        roleId: inviteRoleId,
      });
      setInviteEmail("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invitation");
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(userId: string) {
    await apiDelete(`/api/org/${orgId}/team/members/${userId}`);
    await load();
  }

  async function handleRoleChange(userId: string, roleId: string) {
    await apiPatch(`/api/org/${orgId}/team/members/${userId}/role`, { roleId });
    await load();
  }

  async function handleRevokeInvite(inviteId: string) {
    await apiDelete(`/api/org/${orgId}/team/invitations/${inviteId}`);
    await load();
  }

  // Owner role cannot be reassigned via the picker.
  const assignableRoles = roles.filter((r) => r.systemKey !== "owner");

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Team</h1>

      {/* Invite form */}
      <Can permission="team:invite">
        <div className="border border-border rounded-xl p-4 mb-6">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">Invite a member</h2>
          <div className="flex gap-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@example.com"
              aria-label="Invite email address"
              className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
            />
            <select
              value={inviteRoleId}
              onChange={(e) => setInviteRoleId(e.target.value)}
              aria-label="Invite role"
              className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary"
            >
              {assignableRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleInvite()}
              disabled={inviting}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {inviting ? "Inviting..." : "Invite"}
            </button>
          </div>
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>
      </Can>

      {/* Members list */}
      <h2 className="text-sm font-medium text-on-surface-secondary mb-3">
        Members ({members.length})
      </h2>
      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden mb-6">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Email
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Role
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isOwner = member.roleSystemKey === "owner" || member.role === "owner";
                const currentRoleId =
                  member.roleId ?? roles.find((r) => r.systemKey === member.role)?.id ?? "";
                return (
                  <tr
                    key={member.id}
                    className="border-b border-border/50 hover:bg-surface-raised/50"
                  >
                    <td className="px-4 py-2 text-sm text-on-surface-secondary">
                      {member.displayName ?? "-"}
                    </td>
                    <td className="px-4 py-2 text-sm text-on-surface-tertiary">{member.email}</td>
                    <td className="px-4 py-2">
                      {canChangeRoles && !isOwner ? (
                        <select
                          value={currentRoleId}
                          onChange={(e) => void handleRoleChange(member.id, e.target.value)}
                          aria-label={`Role for ${member.email}`}
                          className="bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary"
                        >
                          {assignableRoles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-on-surface-tertiary">
                          {member.roleName ?? member.role}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {canRemove && !isOwner && (
                        <button
                          type="button"
                          onClick={() => void handleRemove(member.id)}
                          className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending invitations */}
      {invites.filter((i) => !i.acceptedAt).length > 0 && (
        <>
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">
            Pending invitations ({invites.filter((i) => !i.acceptedAt).length})
          </h2>
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs text-on-surface-muted">
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Email
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Role
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="text-right px-4 py-2 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {invites.flatMap((invite) =>
                  invite.acceptedAt ? (
                    []
                  ) : (
                    <tr
                      key={invite.id}
                      className="border-b border-border/50 hover:bg-surface-raised/50"
                    >
                      <td className="px-4 py-2 text-sm text-on-surface-secondary">
                        {invite.email}
                      </td>
                      <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                        {invite.roleName ?? invite.role}
                      </td>
                      <td className="px-4 py-2 text-xs text-on-surface-muted">
                        {new Date(invite.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {canInvite && (
                          <button
                            type="button"
                            onClick={() => void handleRevokeInvite(invite.id)}
                            className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
