/**
 * Generated Terraform for stored resources: what `POST
 * /resources/{pluginId}/{typeId}/export-terraform` (one resource and its direct
 * children) and `GET /accounts/{id}/export-terraform` (a whole account) answer.
 */
import { Schema } from "effect";
import { ResourceId } from "./common";

export const TerraformExport = Schema.Struct({
  /** The generated HCL document: empty string when nothing could be mapped. */
  hcl: Schema.String,
  exported: Schema.Array(
    Schema.Struct({
      id: ResourceId,
      displayName: Schema.String,
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
      /** Terraform address, e.g. `hcloud_server.web_1`. */
      address: Schema.String,
      /** `terraform import` ID when known. */
      importId: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Resources that have no Terraform mapping yet, with the reason. */
  unsupported: Schema.Array(
    Schema.Struct({
      id: ResourceId,
      displayName: Schema.String,
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
      reason: Schema.String,
    }),
  ),
}).annotate({ identifier: "TerraformExport" });
