import { f, o, rt } from "@infrawrench/plugin-base";

export const TrainingResourceType = rt({
  name: "Training",
  id: "training",
  description: "A fine-tuning run on Replicate that produces a new model version",
  fields: [
    f("trainingId", "Training ID"),
    f("status", "Status", { required: false }),
    f("model", "Trainer Model", { required: false }),
    f("version", "Trainer Version", { required: false }),
    f("destination", "Destination Model", { required: false }),
    f("error", "Error", { required: false }),
    f("predictTime", "Train Time (s)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [
    o("trainingId", "Training ID"),
    o("destinationVersion", "Trained Version ID"),
    o("status", "Status"),
  ],
  supportsDelete: false,
  iconKey: "pipeline",
});
