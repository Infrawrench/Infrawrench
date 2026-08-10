import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { gcpTerraformExport } from "../terraform.js";

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `account:${resourceTypeId}:example`,
    pluginId: "gcp",
    resourceTypeId,
    accountId: "account",
    displayName: "example",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "projects/example/global/example",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("gcpTerraformExport", () => {
  it("maps a GCS bucket", () => {
    expect(
      gcpTerraformExport.mapResource(
        resource("gcs-bucket", { name: "logs-example", location: "US" }),
      ),
    ).toMatchObject({
      resource: { type: "google_storage_bucket", attributes: { name: { value: "logs-example" } } },
    });
  });

  it("maps a VPC network", () => {
    expect(gcpTerraformExport.mapResource(resource("vpc-network", { name: "main" }))).toMatchObject(
      {
        resource: { type: "google_compute_network", attributes: { name: { value: "main" } } },
      },
    );
  });

  it("maps a regional subnetwork", () => {
    expect(
      gcpTerraformExport.mapResource(
        resource("subnet", {
          name: "apps",
          region: "us-central1",
          network: "main",
          ipCidrRange: "10.0.0.0/24",
        }),
      ),
    ).toMatchObject({
      resource: {
        type: "google_compute_subnetwork",
        attributes: { region: { value: "us-central1" } },
      },
    });
  });
});
