/**
 * Components the hand-written Zod registry still defines, referenced rather
 * than redefined.
 *
 * Some response bodies embed a component whose owning route is still on Hono
 * (`TerraformExport` is the resource routes'). Defining it
 * again here would replace the Zod definition for every operation in the
 * document, so a domain refers to it by name: the document carries a bare
 * `$ref` to the registry's definition, and on the wire it is whatever the
 * service sent. When the owning route moves, its domain defines the component
 * and the reference here becomes an import of that schema.
 */
import { Schema } from "effect";

// The reference rides the encoded side, as `plugin-registry.ts`'s does: a
// check on `Schema.Unknown` itself is dropped from the JSON Schema.
const zodComponent = (name: string) =>
  Schema.Unknown.pipe(
    Schema.encodeTo(
      Schema.Any.check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => ({ $ref: `#/components/schemas/${name}` }),
        }),
      ),
    ),
  );

/**
 * The agent-link platform's own agent shapes, which the org tree's Settings
 * edit shares with the link-authenticated routes. Their owner has moved: the
 * `agent-link-platform` domain defines them (`./agent-links.ts`). They stay
 * references rather than imports here because the org tree never decoded
 * them (a `PatchPlatformAgent` body is checked by hand there), and the real
 * schema would start refusing bodies those routes have always accepted.
 */
export const PatchPlatformAgent = zodComponent("PatchPlatformAgent");
export const PlatformAgentEnvelope = zodComponent("PlatformAgentEnvelope");
export const AgentLinkScopeGroup = zodComponent("AgentLinkScopeGroup");
export const AgentLinkProvider = zodComponent("AgentLinkProvider");
