import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelTeamResourceType = rt({
  name: "Team",
  id: "vercel-team",
  description: "A Vercel team — a shared workspace for projects and deployments",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
    f("memberCount", "Members", { required: false }),
  ],
  outputs: [o("teamId", "Team ID"), o("teamSlug", "Team Slug")],
  supportsCreate: true,
  iconKey: "team",
});
