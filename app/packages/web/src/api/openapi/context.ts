import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { DynamicEnums } from "./dynamic";

/**
 * Shared registration context passed to each `register*Paths(ctx)` function.
 * Lives in its own module (rather than `./index`) so path files can import
 * it without creating a circular dependency back through the barrel.
 */
export interface BuildContext {
  registry: OpenAPIRegistry;
  enums: DynamicEnums;
}
