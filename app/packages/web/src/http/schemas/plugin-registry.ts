/**
 * Components the spec builder derives from the loaded plugins, referenced
 * rather than defined.
 *
 * `PluginId` is an enum of every installed plugin's manifest id, built at
 * spec time from the live registry (`api/openapi/dynamic.ts`). Endpoint
 * definitions cannot load plugins (they must stay importable by a client),
 * and defining a plain-string `PluginId` here would replace the enum for every
 * operation in the document. So a domain refers to the component by name: on
 * the wire and in a handler it is a string, and the document carries a bare
 * `$ref` to the registry's definition.
 */
import { Predicate, Schema } from "effect";

const componentRef = (name: string) =>
  Schema.String.pipe(
    Schema.encodeTo(
      Schema.Any.check(
        Schema.makeFilter(Predicate.isString, {
          toJsonSchema: () => ({ $ref: `#/components/schemas/${name}` }),
        }),
      ),
    ),
  );

/** Manifest id of an installed plugin (the `PluginId` enum component). */
export const PluginId = componentRef("PluginId");
