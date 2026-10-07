import { describe, expect, it } from "vitest";
import { fieldNumber, fieldString, tf, type TerraformExportCapability } from "@infrawrench/plugin-base";

import {
  classifyPrCheckPath,
  deriveTerraformAttributeFieldMap,
  pathInPrCheckDirectories,
  prCheckConclusion,
  prCheckMissingPermissions,
  terraformAttributesToFields,
  validatePrCheckRepositoryInput,
  type PrCheckInstallationAccess,
} from "../index";

/** A mapper shaped like the real ones: strings, a number, a transformed value. */
const capability: TerraformExportCapability = {
  provider: { name: "acme", source: "acme/acme", version: "~> 1.0" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: ["vm"],
  mapResource(resource) {
    const size = fieldString(resource, "size");
    const region = fieldString(resource, "region");
    const disk = fieldNumber(resource, "diskGb");
    if (!size || !region) return null;
    return {
      resource: {
        type: "acme_vm",
        name: resource.displayName,
        attributes: {
          size: tf.str(size),
          location: tf.str(region),
          ...(disk !== undefined ? { disk_size: tf.num(disk) } : {}),
          // Transformed: cannot be read backwards.
          image: tf.str(fieldString(resource, "image").toUpperCase()),
          tags: tf.map({ Name: tf.str(resource.displayName) }),
        },
      },
    };
  },
};

describe("deriveTerraformAttributeFieldMap", () => {
  it("reads the mapper backwards for values that round-trip", () => {
    const map = deriveTerraformAttributeFieldMap(capability, "acme", "vm");
    expect(Object.fromEntries(map.fieldByAttribute)).toEqual({
      size: "size",
      location: "region",
      disk_size: "diskGb",
    });
    expect([...map.attributes].sort()).toEqual(["disk_size", "image", "location", "size", "tags"]);
    expect(
      terraformAttributesToFields(map, {
        size: "large",
        location: "eu-west-1",
        disk_size: 40,
        image: "ubuntu",
      }),
    ).toEqual({ size: "large", region: "eu-west-1", diskGb: "40" });
  });

  it("maps nothing for an unsupported type or a missing capability", () => {
    expect(deriveTerraformAttributeFieldMap(capability, "acme", "db").fieldByAttribute.size).toBe(0);
    expect(deriveTerraformAttributeFieldMap(undefined, "acme", "vm").attributes.size).toBe(0);
  });
});

describe("pull request check helpers", () => {
  it("classifies infrastructure paths", () => {
    expect(classifyPrCheckPath("infra/main.tf")).toBe("terraform");
    expect(classifyPrCheckPath("Infrafile")).toBe("infrafile");
    expect(classifyPrCheckPath("k8s/app.yaml")).toBeNull();
    expect(classifyPrCheckPath("k8s/app.yaml", "apiVersion: v1\nkind: Service\n")).toBe(
      "kubernetes",
    );
    expect(classifyPrCheckPath("README.md")).toBeNull();
  });

  it("scopes by directory prefix, not substring", () => {
    expect(pathInPrCheckDirectories("infra/prod/main.tf", ["infra/prod"])).toBe(true);
    expect(pathInPrCheckDirectories("infra/production/main.tf", ["infra/prod"])).toBe(false);
    expect(pathInPrCheckDirectories("anything.tf", [])).toBe(true);
  });

  it("trips the threshold only on a known increase above it", () => {
    const totals = (monthlyDelta: number | null) => ({
      totals: {
        monthlyDelta,
        currency: "USD",
        partial: false,
        pricedChanges: 1,
        unpricedChanges: 0,
        otherCurrencyChanges: 0,
      },
    });
    const settings = { costThreshold: 100, thresholdConclusion: "failure" as const };
    expect(prCheckConclusion(totals(150), settings)).toBe("failure");
    expect(prCheckConclusion(totals(100), settings)).toBe("success");
    expect(prCheckConclusion(totals(null), settings)).toBe("success");
    expect(prCheckConclusion(totals(1e9), { ...settings, costThreshold: null })).toBe("success");
  });

  it("validates repository input", () => {
    const ok = {
      installationId: 1,
      repo: "acme/infra",
      enabled: true,
      commentEnabled: false,
      costThreshold: 50,
      thresholdConclusion: "neutral" as const,
      directories: ["infra"],
    };
    expect(validatePrCheckRepositoryInput(ok)).toBeNull();
    expect(validatePrCheckRepositoryInput({ ...ok, repo: "nope" })).not.toBeNull();
    expect(validatePrCheckRepositoryInput({ ...ok, costThreshold: -1 })).not.toBeNull();
    expect(validatePrCheckRepositoryInput({ ...ok, directories: ["../x"] })).not.toBeNull();
  });

  it("names the GitHub permissions still to approve", () => {
    const access: PrCheckInstallationAccess = {
      installationId: 1,
      accountLogin: "acme",
      checks: "none",
      pullRequests: "read",
      contents: "read",
      suspended: false,
      manageUrl: null,
      checked: true,
    };
    expect(prCheckMissingPermissions(access, false)).toEqual(["checks"]);
    expect(prCheckMissingPermissions(access, true)).toEqual(["checks", "pull_requests"]);
    expect(prCheckMissingPermissions({ ...access, checked: false }, true)).toEqual([]);
  });
});
