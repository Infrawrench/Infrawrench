import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { apiGet, apiPost, apiDelete, apiPatch } from "@/lib/api";

interface TeamMember {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  createdAt: string;
}

interface InvitationSummary {
  id: string;
  email: string;
  role: string;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export const Route = createFileRoute("/org/$orgId/settings/team")({
  component: TeamPage,
});

function TeamPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/team" });
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<InvitationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [m, i] = await Promise.all([
      apiGet<TeamMember[]>(`/api/org/${orgId}/team/members`),
      apiGet<InvitationSummary[]>(`/api/org/${orgId}/team/invitations`),
    ]);
    setMembers(m);
    setInvites(i);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    try {
      await apiPost(`/api/org/${orgId}/team/invitations`, {
        email: inviteEmail.trim(),
        role: inviteRole,
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

  async function handleRoleChange(userId: string, role: string) {
    await apiPatch(`/api/org/${orgId}/team/members/${userId}/role`, { role });
    await load();
  }

  async function handleRevokeInvite(inviteId: string) {
    await apiDelete(`/api/org/${orgId}/team/invitations/${inviteId}`);
    await load();
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Team</h1>

      {/* Invite form */}
      <div className="border border-gray-800 rounded-xl p-4 mb-6">
        <h2 className="text-sm font-medium text-gray-300 mb-3">Invite a member</h2>
        <div className="flex gap-3">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="email@example.com"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            onClick={() => void handleInvite()}
            disabled={inviting}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {inviting ? "Inviting..." : "Invite"}
          </button>
        </div>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>

      {/* Members list */}
      <h2 className="text-sm font-medium text-gray-300 mb-3">Members ({members.length})</h2>
      {loading ? (
        <p className="text-sm text-gray-600">Loading...</p>
      ) : (
        <div className="border border-gray-800 rounded-xl overflow-hidden mb-6">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500">
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Email</th>
                <th className="text-left px-4 py-2 font-medium">Role</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="px-4 py-2 text-sm text-gray-200">{member.displayName ?? "-"}</td>
                  <td className="px-4 py-2 text-sm text-gray-400">{member.email}</td>
                  <td className="px-4 py-2">
                    <select
                      value={member.role}
                      onChange={(e) => void handleRoleChange(member.id, e.target.value)}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
                      disabled={member.role === "owner"}
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {member.role !== "owner" && (
                      <button
                        onClick={() => void handleRemove(member.id)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending invitations */}
      {invites.filter((i) => !i.acceptedAt).length > 0 && (
        <>
          <h2 className="text-sm font-medium text-gray-300 mb-3">
            Pending invitations ({invites.filter((i) => !i.acceptedAt).length})
          </h2>
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500">
                  <th className="text-left px-4 py-2 font-medium">Email</th>
                  <th className="text-left px-4 py-2 font-medium">Role</th>
                  <th className="text-left px-4 py-2 font-medium">Expires</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invites
                  .filter((i) => !i.acceptedAt)
                  .map((invite) => (
                    <tr
                      key={invite.id}
                      className="border-b border-gray-800/50 hover:bg-gray-900/50"
                    >
                      <td className="px-4 py-2 text-sm text-gray-300">{invite.email}</td>
                      <td className="px-4 py-2 text-xs text-gray-400">{invite.role}</td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {new Date(invite.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => void handleRevokeInvite(invite.id)}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
