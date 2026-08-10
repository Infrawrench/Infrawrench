import { f, o, rt } from "@infrawrench/plugin-base";

export const FineTuneResourceType = rt({
  name: "Fine-Tune",
  id: "fine-tune",
  plural: "Fine-Tunes",
  description: "A Together AI fine-tuning job and the adapter or full model it produces",
  fields: [
    f("jobId", "Job ID"),
    f("status", "Status", { required: false }),
    f("baseModel", "Base Model", { required: false }),
    f("outputName", "Output Model", { required: false }),
    f("trainingFile", "Training File", { required: false }),
    f("validationFile", "Validation File", { required: false }),
    f("trainingType", "Training Type", { required: false }),
    f("loraRank", "LoRA Rank", { kind: "number", required: false }),
    f("epochs", "Epochs", { kind: "number", required: false }),
    f("batchSize", "Batch Size", { kind: "number", required: false }),
    f("learningRate", "Learning Rate", { kind: "number", required: false }),
    f("tokenCount", "Tokens Processed", { kind: "number", required: false }),
    f("totalPrice", "Price (USD)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [
    o("jobId", "Job ID"),
    o("outputName", "Output Model Name", {
      description: "Pass this as `model` once the job has completed",
    }),
    o("status", "Status"),
  ],
  // `model` on the job is the base model's `/models` id; the two file fields
  // are `/files` ids. `outputName` is deliberately absent — it names the model
  // the job produces, which is the reverse direction.
  dependsOn: [
    { fieldKey: "baseModel", targetTypeId: "model", label: "trained from" },
    { fieldKey: "trainingFile", targetTypeId: "file", label: "trains on" },
    { fieldKey: "validationFile", targetTypeId: "file", label: "validates on" },
  ],
  iconKey: "model",
});
