import { f, o, rt } from "@infrawrench/plugin-base";

export const GcpProjectResourceType = rt({
  name: "Project",
  pinnable: false,
  id: "gcp-project",
  description: "A GCP project this account's credentials can see",
  fields: [
    f("projectId", "Project ID"),
    f("name", "Name", { required: false }),
    f("projectNumber", "Project Number", { required: false }),
    f("state", "State", { required: false }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    // Minted from the account's own credentials on demand, so an Infrafile can
    // authenticate gcloud/docker without asking the operator to paste the
    // service-account key: `docker login -u oauth2accesstoken`, or
    // CLOUDSDK_AUTH_ACCESS_TOKEN for gcloud. Valid for about an hour.
    o("accessToken", "Access token (OAuth2, ~1h)", { sensitive: true }),
  ],
  supportsCreate: false,
  supportsDelete: false,
  supportsMetrics: false,
});
