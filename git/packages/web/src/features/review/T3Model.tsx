/**
 * The model a T3 Code thread is started with: the environment's providers
 * and models by name, and the chosen model's reasoning levels where it has
 * any. The project's default for the repository is chosen to begin with;
 * a project with none waits for the person.
 *
 * An environment that cannot list its models (an older T3 Code) does not
 * stop the work: the fields say why, and the thread starts with whatever
 * model the forge finds for it.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { T3Model, T3ModelChoice, T3ModelProvider } from "@infrawrench/git-contract";
import { queries } from "../../api/queries";
import { Field, Select } from "../../components/forms";
import { optional } from "./optional";

/** A model in a select's value. Neither id holds a newline. */
const keyOf = (providerId: string, modelId: string): string => `${providerId}\n${modelId}`;

const modelAt = (
  providers: ReadonlyArray<T3ModelProvider>,
  key: string,
): { provider: T3ModelProvider; model: T3Model } | null => {
  for (const provider of providers) {
    for (const model of provider.models) {
      if (keyOf(provider.id, model.id) === key) return { provider, model };
    }
  }
  return null;
};

/** A level as a person reads it: `xhigh` is T3 Code's id for "Extra high". */
const LEVEL_LABEL: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
export const levelLabel = (level: string): string =>
  LEVEL_LABEL[level] ?? level.charAt(0).toUpperCase() + level.slice(1);

export interface T3ModelFields {
  /** The Model field and, for a model with levels, the Reasoning field. */
  readonly fields: ReactNode;
  /** What to send. Undefined while nothing is chosen, or when the models could not be listed. */
  readonly choice: T3ModelChoice | undefined;
  /** Whether work can start: a model is chosen, or there is no list to choose from. */
  readonly ready: boolean;
}

export function useT3ModelFields({
  environmentId,
  repo,
  enabled,
}: {
  environmentId: string | null;
  repo: { owner: string; repo: string };
  enabled: boolean;
}): T3ModelFields {
  // What the person picked, per environment: another environment has other models.
  const [picked, setPicked] = useState<{ environmentId: string; key: string } | null>(null);
  const [level, setLevel] = useState<{ key: string; level: string } | null>(null);
  const models = useQuery({
    ...optional(
      queries.t3.listModels({ params: { environmentId: environmentId ?? "" }, query: repo }),
    ),
    enabled: enabled && environmentId !== null,
  });
  if (!enabled || environmentId === null) return { fields: null, choice: undefined, ready: true };
  if (models.error !== null) {
    return {
      fields: (
        <p className="text-xs text-on-surface-muted sm:col-span-2">
          This environment did not list its models ({models.error.message}). The thread starts with
          the project's default model, or one picked for it.
        </p>
      ),
      choice: undefined,
      ready: true,
    };
  }
  if (models.data === undefined) {
    return {
      fields: (
        <Field label="Model">
          {(control) => (
            <Select {...control} disabled value="">
              <option value="">Loading models</option>
            </Select>
          )}
        </Field>
      ),
      choice: undefined,
      ready: false,
    };
  }

  const { providers } = models.data;
  const preset = models.data.default;
  const presetKey = preset === null ? "" : keyOf(preset.providerId, preset.model);
  const key =
    picked !== null &&
    picked.environmentId === environmentId &&
    modelAt(providers, picked.key) !== null
      ? picked.key
      : modelAt(providers, presetKey) !== null
        ? presetKey
        : "";
  const found = modelAt(providers, key);
  const reasoning = found?.model.reasoning ?? null;
  // The person's level for this model, else the project's, else the model's own.
  const wanted =
    level !== null && level.key === key
      ? level.level
      : key === presetKey && preset?.reasoning !== undefined
        ? preset.reasoning.level
        : (reasoning?.default ?? "");
  const chosenLevel = reasoning !== null && reasoning.levels.includes(wanted) ? wanted : "";

  const choice: T3ModelChoice | undefined =
    found === null
      ? undefined
      : {
          providerId: found.provider.id,
          model: found.model.id,
          ...(reasoning === null || chosenLevel === ""
            ? {}
            : { reasoning: { optionId: reasoning.optionId, level: chosenLevel } }),
        };

  const fields = (
    <>
      <Field label="Model">
        {(control) => (
          <Select
            {...control}
            required
            value={key}
            onChange={(event) => setPicked({ environmentId, key: event.target.value })}
          >
            {key === "" ? (
              <option value="" disabled>
                {providers.length === 0 ? "No models available" : "Choose a model"}
              </option>
            ) : null}
            {providers.map((provider) => (
              <optgroup key={provider.id} label={provider.name}>
                {provider.models.map((model) => (
                  <option key={model.id} value={keyOf(provider.id, model.id)}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
      </Field>
      {reasoning !== null ? (
        <Field label="Reasoning">
          {(control) => (
            <Select
              {...control}
              value={chosenLevel}
              onChange={(event) => setLevel({ key, level: event.target.value })}
            >
              {/* A model that names no level of its own can be left at whatever it runs by itself. */}
              {reasoning.default === null ? <option value="">Default</option> : null}
              {reasoning.levels.map((each) => (
                <option key={each} value={each}>
                  {levelLabel(each)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
    </>
  );
  // No provider can run anything: T3 Code says so itself when asked to start.
  return { fields, choice, ready: choice !== undefined || providers.length === 0 };
}
