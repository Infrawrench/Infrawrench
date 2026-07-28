import { f, o, rt } from "@infrawrench/plugin-base";

export const PredictionResourceType = rt({
  name: "Prediction",
  id: "prediction",
  description: "A single run of a model on Replicate, with its input, output and timing metrics",
  fields: [
    f("predictionId", "Prediction ID"),
    f("status", "Status", { required: false }),
    f("model", "Model", { required: false }),
    f("version", "Version", { required: false }),
    f("source", "Source", { required: false }),
    f("deployment", "Deployment", { required: false }),
    f("error", "Error", { required: false }),
    f("predictTime", "Predict Time (s)", { kind: "number", required: false }),
    f("totalTime", "Total Time (s)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("completedAt", "Completed", { required: false }),
    f("deadline", "Deadline", { required: false }),
    f("dataRemoved", "Data Removed", { kind: "boolean", required: false }),
    f("webUrl", "Web URL", { required: false }),
  ],
  outputs: [
    o("predictionId", "Prediction ID"),
    o("outputUrl", "Output URL", {
      description:
        "First output URL, when the model returned files. replicate.delivery URLs for API-created predictions expire one hour after the prediction completes.",
    }),
    o("status", "Status"),
    o("webUrl", "Web URL"),
  ],
  supportsDelete: false,
  iconKey: "function",
});
