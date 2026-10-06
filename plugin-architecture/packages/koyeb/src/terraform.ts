import type { TerraformExportCapability, TerraformExportResult } from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `koyeb/koyeb` provider (v0.2, docs in
 * github.com/koyeb/terraform-provider-koyeb/docs, verified 2026-10). The
 * provider takes no arguments: it reads the token from `KOYEB_TOKEN`. Its
 * app, secret and volume resources import by id (passthrough importers).
 *
 *   - koyeb_app: `name`.
 *   - koyeb_secret: `name`, `value` (sensitive; written as a variable), simple secrets only.
 *   - koyeb_volume: `name`, `region`, `max_size` (GB), `read_only`.
 *
 * Services are skipped: `koyeb_service` needs the whole deployment
 * definition (ports, routes, env, health checks), which inventory does not
 * carry faithfully.
 */
export const koyebTerraformExport: TerraformExportCapability = {
  provider: { name: "koyeb", source: "koyeb/koyeb", version: "~> 0.2" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: ["app", "secret", "volume"],
  mapResource(r): TerraformExportResult | null {
    const name = fieldString(r, "name") || r.displayName;
    switch (r.resourceTypeId) {
      case "app":
        return {
          resource: {
            type: "koyeb_app",
            name,
            attributes: { name: tf.str(name) },
            importId: r.externalId,
            comments: [
              "The koyeb provider reads its API token from the KOYEB_TOKEN environment variable.",
            ],
          },
        };
      case "secret": {
        if (fieldString(r, "type") !== "SIMPLE") return null;
        const variable = `koyeb_secret_${name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
        return {
          resource: {
            type: "koyeb_secret",
            name,
            attributes: { name: tf.str(name), value: tf.ref(`var.${variable}`) },
            importId: r.externalId,
          },
          variables: [
            { name: variable, description: `Value of the Koyeb secret ${name}`, sensitive: true },
          ],
        };
      }
      case "volume": {
        const region = fieldString(r, "region");
        const size = fieldNumber(r, "sizeGb");
        if (!region || size === undefined) return null;
        return {
          resource: {
            type: "koyeb_volume",
            name,
            attributes: {
              name: tf.str(name),
              region: tf.str(region),
              max_size: tf.num(size),
              ...(fieldBool(r, "readOnly") ? { read_only: tf.bool(true) } : {}),
            },
            importId: r.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
