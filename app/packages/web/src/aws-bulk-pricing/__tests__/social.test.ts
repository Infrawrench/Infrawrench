import { describe, expect, it } from "vitest";

import {
  MAX_POSTS,
  blueskyRecord,
  changesSince,
  compose,
  oauthSignature,
  plan,
  type Change,
} from "../social";
import type { ClickHouseHttp } from "../warehouse";

describe("compose", () => {
  it("names a new type with its specs and links its page", () => {
    const post = compose({
      kind: "new",
      platform: "ec2",
      name: "m8g.large",
      vcpu: 2,
      memory: 8,
      gpus: 0,
      gpuModel: "",
    });
    expect(post.text).toBe(
      "New on AWS EC2: m8g.large, 2 vCPUs, 8 GiB.\n\nhttps://instances.infrawrench.com/aws/ec2/m8g.large",
    );
  });

  it("links pages under the platform's own path", () => {
    const post = compose({ kind: "retired", platform: "azure", name: "Standard_A1" });
    expect(post.url).toBe("https://instances.infrawrench.com/azure/vms/Standard_A1");
  });

  it("describes a price move with its size, direction and regions", () => {
    const post = compose({
      kind: "price",
      platform: "ec2",
      name: "p4d.24xlarge",
      spot: true,
      region: "us-west-2",
      from: 10,
      to: 25,
      regions: 3,
    });
    expect(post.text.split("\n")[0]).toBe(
      "AWS EC2 p4d.24xlarge spot price up 150% in 3 regions, most in us-west-2: $10.00/hr to $25.00/hr.",
    );
  });

  it("keeps every post within X's 280 characters", () => {
    const post = compose({
      kind: "new",
      platform: "sagemaker",
      name: "ml.p5en.48xlarge-with-a-very-long-name",
      vcpu: 192,
      memory: 2048,
      gpus: 8,
      gpuModel: "NVIDIA H200",
    });
    expect(post.text.length).toBeLessThanOrEqual(280);
  });
});

describe("plan", () => {
  const retired = (name: string): Change => ({ kind: "retired", platform: "ec2", name });

  it("puts launches first and folds the rest into one post", () => {
    const changes: Change[] = [
      ...Array.from({ length: MAX_POSTS + 2 }, (_, i) => retired(`t${i}.nano`)),
      {
        kind: "new",
        platform: "gcp",
        name: "c4a-standard-4",
        vcpu: 4,
        memory: 16,
        gpus: 0,
        gpuModel: "",
      },
    ];
    const posts = plan(changes);
    expect(posts).toHaveLength(MAX_POSTS + 1);
    expect(posts[0]!.text).toMatch(/^New on Google Cloud: c4a-standard-4/);
    expect(posts.at(-1)!.text).toMatch(/^Plus 3 more instance changes/);
  });

  it("posts nothing when nothing changed", () => {
    expect(plan([])).toEqual([]);
  });
});

describe("blueskyRecord", () => {
  it("marks the link with a facet at its byte offsets", () => {
    const post = compose({ kind: "retired", platform: "ec2", name: "m1.small" });
    const record = blueskyRecord(post, new Date(0));
    const { byteStart, byteEnd } = record.facets[0]!.index;
    const bytes = new TextEncoder().encode(post.text);
    expect(new TextDecoder().decode(bytes.slice(byteStart, byteEnd))).toBe(post.url);
  });
});

describe("oauthSignature", () => {
  // The worked example from X's "Creating a signature" documentation.
  it("matches the documented example", () => {
    const signature = oauthSignature(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json",
      {
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
        include_entities: "true",
        oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
        oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: "1318622958",
        oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        oauth_version: "1.0",
      },
      "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    );
    expect(signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });
});

describe("changesSince", () => {
  /** A warehouse that answers each query by what it selects from. */
  function fake(answers: Record<string, unknown[]>) {
    const queries: string[] = [];
    const ch = {
      rows: async (sql: string) => {
        queries.push(sql);
        const key = Object.keys(answers).find((k) => sql.includes(k));
        return key ? answers[key] : [];
      },
    } as unknown as ClickHouseHttp;
    return { ch, queries };
  }

  it("reads new types, retirements, regions and price moves after the cursor", async () => {
    const { ch, queries } = fake({
      "first_listed >": [
        {
          platform: "ec2",
          instance_type: "m8g.large",
          vcpu: "2",
          memory_gib: 8,
          gpus: null,
          gpu_model: "",
        },
      ],
      "retired_at >": [{ platform: "ec2", instance_type: "m1.small" }],
      "uniqExact(instance_type)": [
        { platform: "ec2", family: "m8g", region: "eu-south-2", types: "6" },
      ],
      "INNER JOIN": [
        {
          platform: "ec2",
          instance_type: "c5.large",
          pricing: "on_demand",
          top_region: "us-east-1",
          old_usd: 0.085,
          new_usd: 0.075,
          regions: "4",
        },
      ],
    });
    const changes = await changesSince(ch, "ec2", "2026-11-05 00:00:00");
    expect(changes.map((c) => c.kind)).toEqual(["new", "retired", "region", "price"]);
    expect(changes[0]).toMatchObject({ vcpu: 2, memory: 8, gpus: null });
    expect(changes[3]).toMatchObject({
      spot: false,
      region: "us-east-1",
      from: 0.085,
      to: 0.075,
      regions: 4,
    });
    expect(queries.every((q) => q.includes("toDateTime('2026-11-05 00:00:00', 'UTC')"))).toBe(true);
    // An alias named after a column used in another aggregate makes ClickHouse
    // expand it and reject the query (ILLEGAL_AGGREGATION).
    const moves = queries.find((q) => q.includes("INNER JOIN"))!;
    expect(moves).not.toMatch(/argMax\(region, abs\(change\)\) AS region\b/);
    expect(moves).toContain("argMax(region, abs(change)) AS top_region");
  });

  it("checks only prices for spot, whose types are EC2's", async () => {
    const { ch, queries } = fake({});
    await changesSince(ch, "spot", "2026-11-05 00:00:00");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("INNER JOIN");
  });
});
