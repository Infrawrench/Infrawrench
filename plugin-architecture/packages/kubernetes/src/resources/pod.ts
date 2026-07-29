import { f, rt } from "@infrawrench/plugin-base";

export const PodResourceType = rt({
  name: "Pod",
  pinnable: false,
  id: "k8s-pod",
  description: "A Kubernetes pod",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("image", "Image"),
    f("status", "Status", { required: false }),
    f("statusReason", "Status Reason", {
      required: false,
      description: "Why a Pending pod is pending — the scheduler's own words",
    }),
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
