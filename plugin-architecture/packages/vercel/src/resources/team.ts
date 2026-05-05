import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VercelTeamResourceType: ResourceTypeDefinition = {
  id: "vercel-team",
  displayName: "Team",
  pluralDisplayName: "Teams",
  description: "A Vercel team — a shared workspace for projects and deployments",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "slug", label: "Slug", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
    { key: "memberCount", label: "Members", kind: "string", required: false },
  ],
  outputs: [
    { key: "teamId", label: "Team ID", sensitive: false },
    { key: "teamSlug", label: "Team Slug", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "team",
};
