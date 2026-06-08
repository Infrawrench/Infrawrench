import { f, o, rt } from "@infrawrench/plugin-base";

export const WorkersAiModelResourceType = rt({
  name: "Workers AI Model",
  pinnable: false,
  id: "workers-ai-model",
  description: "A Cloudflare Workers AI text-generation model you can chat with",
  fields: [
    f("name", "Model"),
    f("task", "Task", { required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [],
  iconKey: "function",
});
