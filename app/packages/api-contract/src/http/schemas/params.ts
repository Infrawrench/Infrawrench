/**
 * Describing a query parameter whose schema is a named component.
 *
 * Annotating a component schema (`ResourceId.annotate({ description })`) for
 * one parameter makes Effect emit a second copy of the component, and when
 * that copy is the first one met it takes the bare name, so the shared
 * component would carry one endpoint's wording. {@link describeQuery} puts the
 * description beside the parameter's `$ref` instead, where the hand-written
 * spec had it.
 */
import { Predicate } from "effect";

/** An `OpenApi.Transform` describing the named query parameters' schemas. */
export const describeQuery =
  (descriptions: Readonly<Record<string, string>>) =>
  (operation: Record<string, unknown>): Record<string, unknown> => {
    const parameters = operation["parameters"];
    if (!Array.isArray(parameters)) return operation;
    return {
      ...operation,
      parameters: parameters.map((parameter: unknown) => {
        if (!Predicate.isObject(parameter) || parameter["in"] !== "query") return parameter;
        const name = parameter["name"];
        const description = Predicate.isString(name) ? descriptions[name] : undefined;
        if (description === undefined) return parameter;
        const schema = Predicate.isObject(parameter["schema"]) ? parameter["schema"] : {};
        return { ...parameter, schema: { ...schema, description } };
      }),
    };
  };
