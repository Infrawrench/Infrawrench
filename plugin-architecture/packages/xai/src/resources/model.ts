import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A model served by the xAI inference API.
 *
 * Folded together from three list endpoints so the user sees one "Models"
 * list rather than three near-identical ones:
 *   - GET /v1/language-models        (chat + vision, full pricing/modalities)
 *   - GET /v1/image-generation-models
 *   - GET /v1/embedding-models
 *
 * Docs: https://docs.x.ai/openapi.json
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model available to this xAI API key, with pricing (including cached and long-context rates) and input/output modalities",
  fields: [
    f("modelId", "Model ID"),
    f("kind", "Kind", {
      kind: "enum",
      enumValues: ["language", "image-generation", "embedding"],
    }),
    f("ownedBy", "Owned By", { required: false }),
    f("version", "Version", { required: false }),
    f("fingerprint", "Fingerprint", { required: false }),
    f("aliases", "Aliases", { required: false }),
    f("inputModalities", "Input Modalities", { required: false }),
    f("outputModalities", "Output Modalities", { required: false }),
    f("created", "Created", { required: false }),
    f("longContextThreshold", "Long-Context Threshold", { kind: "number", required: false }),
    f("maxPromptLength", "Max Prompt Length", { kind: "number", required: false }),
    // Prices arrive as USD cents per 100 million units — see PRICE_PER_MILLION /
    // PRICE_PER_UNIT in client.ts, which is where the scaling happens. The token
    // rows and the per-image/per-search rows share that denomination; only the
    // unit they are quoted against differs.
    f("promptTextTokenPrice", "Prompt Text Price", { kind: "number", required: false }),
    f("completionTextTokenPrice", "Completion Text Price", { kind: "number", required: false }),
    f("cachedPromptTextTokenPrice", "Cached Prompt Price", { kind: "number", required: false }),
    f("promptTextTokenPriceLongContext", "Prompt Text Price (Long Context)", {
      kind: "number",
      required: false,
    }),
    f("completionTextTokenPriceLongContext", "Completion Text Price (Long Context)", {
      kind: "number",
      required: false,
    }),
    f("cachedPromptTextTokenPriceLongContext", "Cached Prompt Price (Long Context)", {
      kind: "number",
      required: false,
    }),
    f("promptImageTokenPrice", "Prompt Image Price", { kind: "number", required: false }),
    f("imagePrice", "Image Price", { kind: "number", required: false }),
    f("searchPrice", "Search Price", { kind: "number", required: false }),
  ],
  outputs: [
    o("modelId", "Model ID", { description: "Pass as `model` in inference requests" }),
    o("ownedBy", "Owned By"),
  ],
  // The detail view has offered a Metrics tab since it was written, but the
  // host only calls `fetchMetricSeries` for types that declare this — so the
  // per-model token series from the management API's usage query never
  // reached it.
  supportsMetrics: true,
  iconKey: "cpu",
});
