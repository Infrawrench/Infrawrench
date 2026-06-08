import { f, o, rt } from "@infrawrench/plugin-base";

export const AppEngineServiceResourceType = rt({
  name: "App Engine Service",
  id: "app-engine-service",
  description: "A Google App Engine service",
  fields: [
    f("name", "Name"),
    f("servingStatus", "Serving Status", { required: false }),
    f("latestVersion", "Latest Version", { required: false }),
    f("trafficSplit", "Traffic Split", { required: false }),
  ],
  outputs: [o("url", "Service URL")],
});
