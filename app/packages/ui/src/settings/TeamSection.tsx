import { useState, useEffect, useCallback } from "react";
import { useGT } from "gt-react";
import { PlanRequiredClientError, SeatLimitReachedClientError } from "@infrawrench/client-core";
import type { InvitationSummary, TeamMember } from "../api-types.js";
import { useDataString } from "../i18n/data-strings.js";
import { useSettingsHost, SettingsCan } from "./host.js";

interface RoleOption {
  id: string;
  name: string;
  isSystem: boolean;
  systemKey: string | null;
}

export function TeamSection() {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api, has, openSection } = useSettingsHost();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<InvitationSummary[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState<string>("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planRequired, setPlanRequired] = useState(false);

  const canInvite = has("team:invite");
  const canChangeRoles = has("team:role:write");
  const canRemove = has("team:remove");

  const load = useCallback(async () => {
    setLoading(true);
    const [m, i, r] = await Promise.all([
      api.get<TeamMember[]>(`/api/org/${orgId}/team/members`),
      api.get<InvitationSummary[]>(`/api/org/${orgId}/team/invitations`),
      api.get<RoleOption[]>(`/api/org/${orgId}/team/roles`).catch(() => [] as RoleOption[]),
    ]);
    setMembers(m);
    setInvites(i);
    setRoles(r);
    if (!inviteRoleId) {
      const memberRole = r.find((role) => role.systemKey === "member");
      if (memberRole) setInviteRoleId(memberRole.id);
    }
    setLoading(false);
  }, [api, orgId, inviteRoleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite() {
    if (!inviteEmail.trim() || !inviteRoleId) return;
    setInviting(true);
    setError(null);
    setPlanRequired(false);
    const body = { email: inviteEmail.trim(), roleId: inviteRoleId };
    try {
      try {
        await api.post(`/api/org/${orgId}/team/invitations`, body);
      } catch (e) {
        if (!(e instanceof SeatLimitReachedClientError)) throw e;
        // The paid plan is full — every member and pending invite holds a
        // seat. Confirm buying one more, then retry with the opt-in flag.
        const { seatCount } = e.payload;
        // Capacity that is entirely prepaid slots has no monthly seat to add,
        // so there is nothing to retry — the org has to buy another slot first.
        if (e.payload.canAddSeat === false) {
          setError(
            gt(
              "All {seatCount} prepaid seats are in use. Buy another capacity slot under Billing to invite more teammates.",
              { seatCount },
            ),
          );
          return;
        }
        if (!has("billing:write")) {
          setError(
            gt(
              "All {seatCount} seats are in use. Ask someone with billing access to add a seat first.",
              {
                seatCount,
              },
            ),
          );
          return;
        }
        if (
          !window.confirm(
            gt(
              "All {seatCount} seats are in use. Add a seat for $20/month and send the invitation?",
              {
                seatCount,
              },
            ),
          )
        ) {
          return;
        }
        await api.post(`/api/org/${orgId}/team/invitations`, { ...body, addSeat: true });
      }
      setInviteEmail("");
      await load();
    } catch (e) {
      if (e instanceof PlanRequiredClientError) setPlanRequired(true);
      setError(e instanceof Error ? e.message : gt("Failed to send invitation"));
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(userId: string) {
    await api.delete(`/api/org/${orgId}/team/members/${userId}`);
    await load();
  }

  async function handleRoleChange(userId: string, roleId: string) {
    await api.patch(`/api/org/${orgId}/team/members/${userId}/role`, { roleId });
    await load();
  }

  async function handleRevokeInvite(inviteId: string) {
    await api.delete(`/api/org/${orgId}/team/invitations/${inviteId}`);
    await load();
  }

  // Owner role cannot be reassigned via the picker.
  const assignableRoles = roles.filter((r) => r.systemKey !== "owner");

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">{gt("Team")}</h1>

      {/* Invite form */}
      <SettingsCan permission="team:invite">
        <div className="border border-border rounded-xl p-4 mb-6">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">
            {gt("Invite a member")}
          </h2>
          <div className="flex gap-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@example.com"
              aria-label={gt("Invite email address")}
              className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
            />
            <select
              value={inviteRoleId}
              onChange={(e) => setInviteRoleId(e.target.value)}
              aria-label={gt("Invite role")}
              className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary"
            >
              {assignableRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {gtData(r.name)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleInvite()}
              disabled={inviting}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {inviting ? gt("Inviting...") : gt("Invite")}
            </button>
          </div>
          {error && (
            <p className="text-xs text-danger mt-2">
              {error}
              {planRequired && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => openSection("billing")}
                    className="text-info hover:text-info-strong underline"
                  >
                    {gt("Upgrade to Pro")}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </SettingsCan>

      {/* Members list */}
      <h2 className="text-sm font-medium text-on-surface-secondary mb-3">
        {gt("Members ({count})", { count: members.length })}
      </h2>
      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden mb-6">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Name")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Email")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Role")}
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  {gt("Actions")}
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
                          aria-label={gt("Role for {email}", { email: member.email })}
                          className="bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary"
                        >
                          {assignableRoles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {gtData(r.name)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-on-surface-tertiary">
                          {gtData(member.roleName ?? member.role)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {canRemove && !isOwner && (
                        <button
                          type="button"
                          onClick={() => void handleRemove(member.id)}
                          className="text-xs text-danger hover:text-danger-strong"
                        >
                          {gt("Remove")}
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
            {gt("Pending invitations ({count})", {
              count: invites.filter((i) => !i.acceptedAt).length,
            })}
          </h2>
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs text-on-surface-muted">
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    {gt("Email")}
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    {gt("Role")}
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    {gt("Expires")}
                  </th>
                  <th scope="col" className="text-right px-4 py-2 font-medium">
                    {gt("Actions")}
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
                        {gtData(invite.roleName ?? invite.role)}
                      </td>
                      <td className="px-4 py-2 text-xs text-on-surface-muted">
                        {new Date(invite.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {canInvite && (
                          <button
                            type="button"
                            onClick={() => void handleRevokeInvite(invite.id)}
                            className="text-xs text-danger hover:text-danger-strong"
                          >
                            {gt("Revoke")}
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
