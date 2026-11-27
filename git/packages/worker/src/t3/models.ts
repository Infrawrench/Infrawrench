/**
 * The models of a T3 Code environment, and choosing one for a thread.
 *
 * Read from T3 Code's source (`packages/contracts/src/orchestratorMcp.ts`,
 * `modelSelection.ts`, `apps/server/src/mcp/toolkits/project/handlers.ts`,
 * main at 0.1.13):
 *
 * - `orchestrator_capabilities` answers `providers`, each `{
 *   providerInstanceId, driverKind, displayName, models, constraints }`. A
 *   model is `{ id, label?, options? }` (the label is left out when it only
 *   restates the id), and an option is `{ id, values, default? }`. A provider
 *   with anything in `constraints` (disabled, not installed, not signed in)
 *   cannot run a thread. The list is short: pinned and current models, with
 *   `omittedModels` counting the rest.
 * - `t3_thread_launch` takes `modelSelection: { instanceId, model, options? }`
 *   with `options` as `[{ id, value }]`, and answers the `modelSelection` the
 *   thread got. Without one, a caller outside a thread gets the project's
 *   default, and is refused when there is none ("Pass modelSelection: the
 *   project has no default model...").
 * - A project (`t3_project_list`) carries `defaultModelSelection`, the same
 *   shape, or null when the project sets none of its own.
 * - The capabilities do not say which option is the reasoning level (the
 *   `role` of T3 Code's own descriptors is not passed on), so it is found
 *   the way T3 Code's clients find it: by id (`REASONING_EFFORT_OPTION_IDS`,
 *   `packages/client-runtime/src/state/threadExecution.ts`).
 *
 * Everything is read leniently, like the rest of `t3/`: a field that is not
 * there is absent, never a failure.
 */
import type { T3Model, T3ModelChoice, T3ModelProvider } from "@infrawrench/git-contract";

type Json = Record<string, unknown>;

const rec = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The ids T3 Code's own clients take for a model's reasoning level, in their order. */
export const REASONING_OPTION_IDS = [
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
  "thought_level",
] as const;

/** Most of anything listed: an environment answers what it likes. */
const MAX_LISTED = 200;
const MAX_TEXT = 200;

const short = (value: string): string => value.slice(0, MAX_TEXT);

const reasoningOf = (options: unknown): T3Model["reasoning"] => {
  const known = list(options).map(rec);
  for (const id of REASONING_OPTION_IDS) {
    const option = known.find((each) => each["id"] === id);
    if (!option) continue;
    const levels = list(option["values"])
      .flatMap((value) => (str(value) === null ? [] : [short(value as string)]))
      .slice(0, 20);
    if (levels.length === 0) continue;
    const preset = str(option["default"]);
    return {
      optionId: id,
      levels,
      default: preset !== null && levels.includes(preset) ? preset : null,
    };
  }
  return null;
};

/** The providers of an `orchestrator_capabilities` answer that can run a thread, with their models. */
export const providersOf = (capabilities: unknown): T3ModelProvider[] =>
  list(rec(capabilities)["providers"])
    .map(rec)
    .flatMap((provider): T3ModelProvider[] => {
      const id = str(provider["providerInstanceId"]);
      if (id === null || id.length > MAX_TEXT || list(provider["constraints"]).length > 0) {
        return [];
      }
      const models = list(provider["models"])
        .map(rec)
        .flatMap((model): T3Model[] => {
          const modelId = str(model["id"]);
          if (modelId === null || modelId.length > MAX_TEXT) return [];
          return [
            {
              id: modelId,
              label: short(str(model["label"]) ?? modelId),
              reasoning: reasoningOf(model["options"]),
            },
          ];
        })
        .slice(0, MAX_LISTED);
      if (models.length === 0) return [];
      return [
        {
          id,
          name: short(str(provider["displayName"]) ?? str(provider["driverKind"]) ?? id),
          models,
        },
      ];
    })
    .slice(0, MAX_LISTED);

/** A `modelSelection` of T3 Code's (a project's default, a thread's own) as a choice. */
export const choiceOf = (selection: unknown): T3ModelChoice | null => {
  const value = rec(selection);
  // `provider` is the name older versions gave `instanceId`.
  const providerId = str(value["instanceId"]) ?? str(value["provider"]);
  const model = str(value["model"]);
  if (providerId === null || model === null) return null;
  if (providerId.length > MAX_TEXT || model.length > MAX_TEXT) return null;
  // Options are `[{ id, value }]`, or an object of them in older versions.
  const options: Array<[string, unknown]> = Array.isArray(value["options"])
    ? value["options"].map(rec).map((each) => [String(each["id"]), each["value"]])
    : Object.entries(rec(value["options"]));
  for (const id of REASONING_OPTION_IDS) {
    const level = str(options.find(([each]) => each === id)?.[1]);
    if (level !== null && level.length <= MAX_TEXT) {
      return { providerId, model, reasoning: { optionId: id, level } };
    }
  }
  return { providerId, model };
};

/** A choice as `t3_thread_launch`'s `modelSelection`. */
export const selectionOf = (choice: T3ModelChoice): Json => ({
  instanceId: choice.providerId,
  model: choice.model,
  ...(choice.reasoning === undefined
    ? {}
    : { options: [{ id: choice.reasoning.optionId, value: choice.reasoning.level }] }),
});

const withDefaultReasoning = (provider: T3ModelProvider, model: T3Model): T3ModelChoice => ({
  providerId: provider.id,
  model: model.id,
  ...(model.reasoning === null || model.reasoning.default === null
    ? {}
    : { reasoning: { optionId: model.reasoning.optionId, level: model.reasoning.default } }),
});

const isClaude = (provider: T3ModelProvider): boolean =>
  /claude/i.test(`${provider.id} ${provider.name}`);

/**
 * The model for a thread nobody chose one for: what the environment says it
 * would inherit when it says so, else a Claude provider's first model, else
 * the first provider's first model. Null when the environment lists none.
 */
export const pickModel = (capabilities: unknown): T3ModelChoice | null => {
  const providers = providersOf(capabilities);
  const answer = rec(capabilities);
  const inherited = choiceOf({
    instanceId: answer["inheritedProviderInstanceId"],
    model: answer["inheritedModel"],
    options: answer["inheritedOptions"],
  });
  if (inherited !== null && providers.some((each) => each.id === inherited.providerId)) {
    return inherited;
  }
  const provider = providers.find(isClaude) ?? providers[0];
  const model = provider?.models[0];
  return provider && model ? withDefaultReasoning(provider, model) : null;
};

/**
 * A choice in words, from the names the environment gave when it gave any:
 * "Codex, GPT-6 Astra", or the model alone when it already says whose it is
 * ("Claude Opus 5.5").
 */
export const choiceName = (
  choice: T3ModelChoice,
  providers: readonly T3ModelProvider[],
): string => {
  const provider = providers.find((each) => each.id === choice.providerId);
  const model = provider?.models.find((each) => each.id === choice.model);
  const providerName = provider?.name ?? choice.providerId;
  const modelName = model?.label ?? choice.model;
  return modelName.toLowerCase().startsWith(providerName.toLowerCase())
    ? modelName
    : `${providerName}, ${modelName}`;
};

/** Whether T3 Code refused a launch for want of a model. */
export const wantsModel = (message: string): boolean =>
  /modelSelection|no default model/i.test(message);
