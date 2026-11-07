import { describe, expect, it, vi } from "vitest";
import { getAwsClients } from "../aws-clients.js";

// These tests read many pages or wait on timers, which runs far slower on CI than locally.
vi.setConfig({ testTimeout: 60_000 });

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

describe("getAwsClients", () => {
  it("lazily builds and memoizes clients per (key,region)", () => {
    const bundle = getAwsClients(creds);
    // Accessing getters builds the underlying SDK clients without network.
    expect(bundle.ec2).toBeDefined();
    expect(bundle.s3).toBeDefined();
    expect(bundle.iam).toBeDefined();
    expect(bundle.dynamoDb).toBeDefined();
    // memoized: same getter returns the same instance
    expect(bundle.ec2).toBe(bundle.ec2);
  });

  it("returns the cached bundle for the same credentials", () => {
    const a = getAwsClients(creds);
    const b = getAwsClients(creds);
    expect(a).toBe(b);
  });

  it("builds a distinct bundle for a different region / session token", () => {
    const a = getAwsClients(creds);
    const b = getAwsClients({ ...creds, region: "eu-west-1" });
    const c = getAwsClients({ ...creds, sessionToken: "tok" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
