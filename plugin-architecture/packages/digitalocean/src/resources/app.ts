import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean App Platform app (`/v2/apps`). Creating an app means writing
 * an app spec against a Git or container source, which is a whole product;
 * Infrawrench lists apps, edits the spec in place (the detail page's Spec
 * tab), redeploys, restarts, rolls back and shows build/deploy/run logs and
 * metrics.
 */
export const AppResourceType = rt({
  name: "App",
  id: "app",
  description: "A DigitalOcean App Platform application.",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("phase", "Deployment Phase", {
      required: false,
      description: "Phase of the active (or in-progress) deployment, e.g. ACTIVE, BUILDING, ERROR.",
    }),
    f("liveUrl", "Live URL", { required: false }),
    f("components", "Components", {
      required: false,
      description: "Comma-separated service, worker, job, static site and function names.",
    }),
    f("activeDeploymentId", "Active Deployment", { required: false }),
    f("lastDeployedAt", "Last Deployed", { required: false }),
    f("tierSlug", "Tier", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("liveUrl", "Live URL"), o("defaultIngress", "Default Ingress")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsMetrics: true,
  iconKey: "app",
});
