import { f, o, rt } from "@infrawrench/plugin-base";

export const HardwareResourceType = rt({
  name: "Hardware",
  id: "hardware",
  plural: "Hardware",
  description: "A GPU configuration a dedicated endpoint can run on, with its current availability",
  fields: [
    f("hardwareId", "Hardware ID"),
    f("gpuType", "GPU Type", { required: false }),
    f("gpuCount", "GPU Count", { kind: "number", required: false }),
    f("gpuMemoryGb", "GPU Memory (GB)", { kind: "number", required: false }),
    f("gpuLink", "GPU Interconnect", { required: false }),
    f("centsPerMinute", "Cents / minute", { kind: "number", required: false }),
    f("availability", "Availability", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [o("hardwareId", "Hardware ID"), o("gpuType", "GPU Type")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "compute",
});
