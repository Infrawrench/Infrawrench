import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface ToolInputJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * A tool's Zod input shape as JSON Schema, for both the MCP server and the
 * chat agent's provider tool definitions.
 *
 * Must NOT use the openApi3 target: OpenAPI 3.0 is a different dialect
 * (boolean exclusiveMinimum/exclusiveMaximum, nullable) that the model APIs
 * reject with "JSON schema is invalid". The default draft-07 output is
 * 2020-12-compatible for the constructs Zod emits. `$refStrategy: "none"`
 * keeps every schema inline.
 *
 * `pipeStrategy: "input"` describes a normalising field (`.transform(trim and
 * lowercase).pipe(slug)`, the business-metric keys) by what the tool accepts.
 * The default renders it as a bare `allOf` of both sides with no `type` of its
 * own, which MCP clients and the connector directory read as an untyped
 * parameter; and the output side's slug pattern would make a validator reject
 * `Active-Customers`, which the handler would have normalised and accepted.
 * The handler's own parse still enforces the output side.
 */
export function toolInputJsonSchema(shape: Record<string, ZodTypeAny>): ToolInputJsonSchema {
  const schema = zodToJsonSchema(z.object(shape), {
    $refStrategy: "none",
    pipeStrategy: "input",
  }) as { properties?: Record<string, unknown>; required?: string[] };
  const required = schema.required ?? [];
  return {
    type: "object",
    properties: schema.properties ?? {},
    ...(required.length > 0 ? { required } : {}),
  };
}
