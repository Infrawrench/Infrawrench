/**
 * The settings section registry — one entry per page, in sidebar order.
 * `key` is the URL segment on web (`/org/:orgId/settings/<key>`, "" for
 * General) and the workspace-tab `section` on both platforms.
 */
export interface SettingsSectionDef {
  key: string;
  label: string;
  /** Hidden outright without this permission (the page could only refuse). */
  requiresPermission?: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { key: "", label: "General" },
  { key: "team", label: "Team" },
  { key: "roles", label: "Roles" },
  { key: "access-requests", label: "Break-glass Access", requiresPermission: "access:read" },
  { key: "ssh-keys", label: "SSH Keys" },
  { key: "ssh-host-keys", label: "Trusted SSH Hosts" },
  {
    key: "session-recordings",
    label: "Session Recordings",
    requiresPermission: "session-recordings:read",
  },
  { key: "bastions", label: "Bastions" },
  { key: "api-keys", label: "API Keys" },
  { key: "credential-hygiene", label: "Credential Hygiene", requiresPermission: "audit:read" },
  { key: "freezes", label: "Change Freezes" },
  { key: "tag-policy", label: "Tag Policy" },
  { key: "config", label: "Config as Code", requiresPermission: "config:read" },
  { key: "approvals", label: "Approvals", requiresPermission: "workflows:read" },
  { key: "paging", label: "Notifications" },
  { key: "jira", label: "Jira", requiresPermission: "jira:read" },
  { key: "billing", label: "Billing" },
  { key: "audit-log", label: "Audit Log" },
];
