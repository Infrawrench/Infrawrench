/**
 * The organization's app policy (`org_product_settings`): which apps
 * ("products") it has turned off.
 *
 * A turned-off app disappears from Home, the sidebar and the Tools launcher,
 * and its tools are neither offered to nor run for the chat agent and the
 * MCP server (`web/src/tools/permissions.ts`). It is not a gate on the HTTP
 * API: the routes behind an app keep answering, under their own permissions.
 *
 * Read per call, never cached in the module: on the edge a cache is per
 * isolate, so one isolate would keep offering an app another had just seen
 * turned off.
 */
import { eq } from "drizzle-orm";
import {
  ALWAYS_ON_PRODUCTS,
  isProductId,
  normalizeDisabledProducts,
  type ProductId,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgProductSettings } from "../db/schema";

/** A submitted policy the store refuses, with the sentence the API answers. */
export class ProductSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductSettingsError";
  }
}

/**
 * A submitted list of apps to turn off, checked: every entry a known app
 * that can be turned off. Unlike a stored row, which is read leniently, a
 * write names exactly what it means or is refused.
 */
export function parseDisabledProducts(input: unknown): ProductId[] {
  if (!Array.isArray(input)) throw new ProductSettingsError("disabled must be a list of app ids");
  for (const id of input) {
    if (!isProductId(id)) {
      throw new ProductSettingsError(`Unknown app: ${typeof id === "string" ? id : typeof id}`);
    }
    if (ALWAYS_ON_PRODUCTS.includes(id)) {
      throw new ProductSettingsError(`The ${id} app cannot be turned off`);
    }
  }
  return normalizeDisabledProducts(input);
}

/** The apps the organization has turned off; none when it never saved. */
export async function disabledProducts(organizationId: string): Promise<ProductId[]> {
  const [row] = await db
    .select({ disabledProducts: orgProductSettings.disabledProducts })
    .from(orgProductSettings)
    .where(eq(orgProductSettings.organizationId, organizationId))
    .limit(1);
  return normalizeDisabledProducts(row?.disabledProducts);
}

/** Replaces the organization's policy, creating the row on first save. */
export async function setDisabledProducts(
  organizationId: string,
  ids: readonly string[],
): Promise<ProductId[]> {
  const disabled = parseDisabledProducts(ids);
  const [row] = await db
    .insert(orgProductSettings)
    .values({ organizationId, disabledProducts: disabled })
    .onConflictDoUpdate({
      target: orgProductSettings.organizationId,
      set: { disabledProducts: disabled, updatedAt: new Date() },
    })
    .returning({ disabledProducts: orgProductSettings.disabledProducts });
  if (!row) throw new Error("Failed to save the app settings");
  return normalizeDisabledProducts(row.disabledProducts);
}
