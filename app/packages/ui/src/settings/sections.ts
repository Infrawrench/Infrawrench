import { msg } from "gt-react";

/**
 * The settings section registry — one entry per page, in sidebar order.
 * `key` is the URL segment on web (`/org/:orgId/settings/<key>`, "" for
 * General) and the workspace-tab `section` on both platforms.
 */
export interface SettingsSectionDef {
  key: string;
  /**
   * gt-encoded via `msg()` — render it through `useMessages()` (both navs do),
   * never raw, or the encoded suffix shows up in the UI. `decodeMsg()` gets
   * the plain English back outside React.
   */
  label: string;
  /** Hidden outright without this permission (the page could only refuse). */
  requiresPermission?: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { key: "", label: msg("General") },
  { key: "team", label: msg("Team") },
  { key: "roles", label: msg("Roles") },
  { key: "access-requests", label: msg("Break-glass Access"), requiresPermission: "access:read" },
  { key: "ssh-keys", label: msg("SSH Keys") },
  { key: "ssh-host-keys", label: msg("Trusted SSH Hosts") },
  {
    key: "session-recordings",
    label: msg("Session Recordings"),
    requiresPermission: "session-recordings:read",
  },
  { key: "bastions", label: msg("Bastions") },
  { key: "api-keys", label: msg("API Keys") },
  // Beside API Keys because it answers the same question for a different kind
  // of credential. Not called "Agents" alone anywhere it could be confused with
  // the coding-agent workspace tab, which is an unrelated feature.
  { key: "agents", label: msg("Agent Credentials"), requiresPermission: "team:read" },
  { key: "credential-hygiene", label: msg("Credential Hygiene"), requiresPermission: "audit:read" },
  { key: "freezes", label: msg("Change Freezes") },
  { key: "tag-policy", label: msg("Tag Policy") },
  { key: "cost-centres", label: msg("Cost Centres"), requiresPermission: "costs:read" },
  // Next to Cost Centres and Currency, the two other pages where one person's
  // edit restates numbers everybody else reads. Visible on `costs:read` (a
  // rule is part of the explanation for a figure); editing needs
  // `org:settings:write`.
  { key: "billing-rules", label: msg("Billing Rules"), requiresPermission: "costs:read" },
  { key: "config", label: msg("Config as Code"), requiresPermission: "config:read" },
  { key: "currency", label: msg("Currency") },
  { key: "cost-exports", label: msg("Cost Exports"), requiresPermission: "costs:read" },
  { key: "approvals", label: msg("Approvals"), requiresPermission: "workflows:read" },
  { key: "paging", label: msg("Notifications") },
  { key: "jira", label: msg("Jira"), requiresPermission: "jira:read" },
  { key: "linear", label: msg("Linear"), requiresPermission: "linear:read" },
  { key: "billing", label: msg("Billing") },
  { key: "audit-log", label: msg("Audit Log") },
];
