import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  matchStateToInventory,
  providerSource,
  stateResourceInstances,
  type InventoryCandidate,
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

/**
 * A state as providers write it: the shapes are the AWS, Google and
 * Cloudflare providers', the values are made up. `fixtures/state.tfstate` is a
 * real one, but `terraform_data` has neither an ARN nor a self link.
 */
const cloudState = fixture("state-cloud.tfstate");

describe("stateResourceInstances", () => {
  it("reads a state the real binary wrote", () => {
    const { instances, dataSources, omitted } = stateResourceInstances(fixture("state.tfstate"));
    expect({ dataSources, omitted }).toEqual({ dataSources: 0, omitted: 0 });
    expect(instances.map((instance) => instance.address)).toEqual([
      "terraform_data.bump",
      "terraform_data.gone[0]",
      "terraform_data.keep",
      "terraform_data.renamed_old",
      "terraform_data.replaced",
    ]);
    for (const instance of instances) {
      expect(instance.provider).toBe("terraform.io/builtin/terraform");
      expect(instance.identifiers).toHaveLength(1);
      expect(instance.identifiers[0]).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("builds addresses with modules, counts and keys, and skips what is not managed", () => {
    const { instances, dataSources } = stateResourceInstances(cloudState);
    expect(dataSources).toBe(1);
    expect(instances.map((instance) => instance.address)).toEqual([
      "aws_instance.web[0]",
      "aws_instance.web[1]",
      "aws_s3_bucket.assets",
      "aws_db_instance.main",
      'module.network.aws_subnet.private["eu-west-1a"]',
      "google_compute_instance.worker",
      "cloudflare_record.www",
      "aws_iam_role.app",
    ]);
    expect(instances[0]).toMatchObject({
      type: "aws_instance",
      name: "web",
      indexKey: 0,
      module: null,
      provider: "registry.terraform.io/hashicorp/aws",
      identifiers: ["i-0aaa1111", "arn:aws:ec2:eu-west-1:111122223333:instance/i-0aaa1111"],
      label: "web-0",
    });
    expect(instances[4]).toMatchObject({ module: "module.network", indexKey: "eu-west-1a" });
    expect(instances[5]?.identifiers).toEqual([
      "projects/acme/zones/europe-west1-b/instances/worker",
      "https://www.googleapis.com/compute/v1/projects/acme/zones/europe-west1-b/instances/worker",
    ]);
  });

  it("carries no attribute but the identifying ones", () => {
    expect(JSON.stringify(cloudState)).toContain("s3cr3t-password");
    expect(JSON.stringify(stateResourceInstances(cloudState))).not.toContain("s3cr3t");
  });

  it("reads the provider out of its address", () => {
    expect(providerSource('provider["registry.terraform.io/hashicorp/aws"]')).toBe(
      "registry.terraform.io/hashicorp/aws",
    );
    expect(providerSource('module.a.provider["registry.opentofu.org/hashicorp/aws"].west')).toBe(
      "registry.opentofu.org/hashicorp/aws",
    );
    expect(providerSource("provider.aws")).toBeNull();
    expect(providerSource(undefined)).toBeNull();
  });

  it("survives a document that is not a state", () => {
    for (const junk of [
      null,
      [],
      "x",
      { resources: "no" },
      { resources: [null, { type: 1 }, { type: "a", name: "b", instances: "x" }] },
    ]) {
      expect(stateResourceInstances(junk).instances).toEqual([]);
    }
  });
});

describe("matchStateToInventory", () => {
  const { instances } = stateResourceInstances(cloudState);

  /** What server-core would hand in: each plugin's own mapper's type and import id. */
  const inventory: InventoryCandidate[] = [
    {
      resourceId: "acc_aws:ec2-instance:i-0aaa1111",
      terraformType: "aws_instance",
      importId: "i-0aaa1111",
      externalId: "i-0aaa1111",
    },
    {
      resourceId: "acc_aws:ec2-instance:i-0bbb2222",
      terraformType: "aws_instance",
      importId: "I-0BBB2222",
      externalId: "i-0bbb2222",
    },
    {
      resourceId: "acc_aws:s3-bucket:acme-assets",
      terraformType: "aws_s3_bucket",
      importId: "acme-assets",
      externalId: "acme-assets",
    },
    // The plugin's external id is the ARN; its import id is the identifier.
    {
      resourceId: "acc_aws:rds-instance:arn:aws:rds:eu-west-1:111122223333:db:main",
      terraformType: "aws_db_instance",
      importId: "db-ABCDEFGHIJ",
      externalId: "arn:aws:rds:eu-west-1:111122223333:db:main",
    },
    // No import id from the mapper: the external id (a self link here) still matches.
    {
      resourceId: "acc_gcp:gce-instance:worker",
      terraformType: "google_compute_instance",
      importId: null,
      externalId:
        "https://www.googleapis.com/compute/v1/projects/acme/zones/europe-west1-b/instances/worker",
    },
    // A plugin with no Terraform mapping at all: matched on an identifier only one entry has.
    {
      resourceId: "acc_cf:dns-record:372e67954025e0ba6aaa6d586b9e0b59",
      terraformType: null,
      importId: null,
      externalId: "372e67954025e0ba6aaa6d586b9e0b59",
    },
    // Synced, but not in this state.
    {
      resourceId: "acc_aws:ec2-instance:i-0ccc3333",
      terraformType: "aws_instance",
      importId: "i-0ccc3333",
      externalId: "i-0ccc3333",
    },
  ];

  it("links by import id, then external id, then a unique identifier", () => {
    const { links, unmatched } = matchStateToInventory(instances, inventory);
    expect(links).toEqual([
      {
        address: "aws_db_instance.main",
        resourceId: "acc_aws:rds-instance:arn:aws:rds:eu-west-1:111122223333:db:main",
        terraformType: "aws_db_instance",
        matchedBy: "import-id",
      },
      {
        address: "aws_instance.web[0]",
        resourceId: "acc_aws:ec2-instance:i-0aaa1111",
        terraformType: "aws_instance",
        matchedBy: "import-id",
      },
      {
        address: "aws_instance.web[1]",
        resourceId: "acc_aws:ec2-instance:i-0bbb2222",
        terraformType: "aws_instance",
        matchedBy: "import-id",
      },
      {
        address: "aws_s3_bucket.assets",
        resourceId: "acc_aws:s3-bucket:acme-assets",
        terraformType: "aws_s3_bucket",
        matchedBy: "import-id",
      },
      {
        address: "cloudflare_record.www",
        resourceId: "acc_cf:dns-record:372e67954025e0ba6aaa6d586b9e0b59",
        terraformType: "cloudflare_record",
        matchedBy: "identifier",
      },
      {
        address: "google_compute_instance.worker",
        resourceId: "acc_gcp:gce-instance:worker",
        terraformType: "google_compute_instance",
        matchedBy: "external-id",
      },
    ]);
    expect(unmatched.map((instance) => instance.address)).toEqual([
      'module.network.aws_subnet.private["eu-west-1a"]',
      "aws_iam_role.app",
    ]);
  });

  it("does not depend on the order the inventory came in", () => {
    const forwards = matchStateToInventory(instances, inventory);
    const backwards = matchStateToInventory(instances, [...inventory].reverse());
    expect(backwards).toEqual(forwards);
  });

  it("never matches across Terraform types on a shared id", () => {
    // An IAM role and an S3 bucket can have the same name, and both use it as their id.
    const { links } = matchStateToInventory(instances, [
      {
        resourceId: "acc_aws:s3-bucket:app",
        terraformType: "aws_s3_bucket",
        importId: "app",
        externalId: "app",
      },
    ]);
    expect(links).toEqual([]);
    const role = matchStateToInventory(instances, [
      {
        resourceId: "acc_aws:iam-role:app",
        terraformType: "aws_iam_role",
        importId: "app",
        externalId: "app",
      },
    ]);
    expect(role.links.map((link) => link.address)).toEqual(["aws_iam_role.app"]);
  });

  it("takes an identifier two entries share as a coincidence when there is no type to tell them apart", () => {
    const twins = stateResourceInstances({
      resources: [
        {
          mode: "managed",
          type: "aws_iam_role",
          name: "a",
          instances: [{ attributes: { id: "app" } }],
        },
        {
          mode: "managed",
          type: "aws_s3_bucket",
          name: "b",
          instances: [{ attributes: { id: "app" } }],
        },
      ],
    }).instances;
    const untyped = {
      resourceId: "acc:thing:app",
      terraformType: null,
      importId: null,
      externalId: "app",
    };
    expect(matchStateToInventory(twins, [untyped]).links).toEqual([]);
    expect(matchStateToInventory(twins.slice(0, 1), [untyped]).links).toHaveLength(1);
  });

  it("links an entry to one resource only", () => {
    const { links } = matchStateToInventory(instances, [
      {
        resourceId: "acc_b:s3-bucket:acme-assets",
        terraformType: "aws_s3_bucket",
        importId: "acme-assets",
        externalId: null,
      },
      {
        resourceId: "acc_a:s3-bucket:acme-assets",
        terraformType: "aws_s3_bucket",
        importId: "acme-assets",
        externalId: null,
      },
    ]);
    expect(links).toEqual([
      {
        address: "aws_s3_bucket.assets",
        resourceId: "acc_a:s3-bucket:acme-assets",
        terraformType: "aws_s3_bucket",
        matchedBy: "import-id",
      },
    ]);
  });
});
