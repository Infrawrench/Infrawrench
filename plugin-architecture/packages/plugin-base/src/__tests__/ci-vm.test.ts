import { describe, expect, it } from "vitest";

import { base64ToBytes } from "../base64.js";
import {
  ciCloudInitScript,
  ciDecodeTagValue,
  ciEncodeTagValue,
  ciHttpStatus,
  ciMachineName,
  ciTagMarker,
  ciTagStrings,
  ciTagsFromStrings,
  ciThrowawayPassword,
  ciThrowawaySshKey,
} from "../ci-vm.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX4Q8W2M3N5P6R7S8T9V0WX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};

describe("ciCloudInitScript", () => {
  it("sets the shutdown timer first, runs the bootstrap, then powers off", () => {
    const script = ciCloudInitScript("#!/bin/sh\necho hi\n", 3599);
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe("shutdown -h +60 >/dev/null 2>&1 || true");
    expect(script).toContain("(\necho hi\n\n)\nshutdown -h now\n");
    expect(script).not.toContain("#!/bin/sh");
    expect(ciCloudInitScript("true", 1)).toContain("shutdown -h +1 ");
  });
});

describe("ciMachineName", () => {
  it("is a stable hostname from the job", () => {
    expect(ciMachineName({ tags, name: "x" })).toBe("iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  });
});

describe("tag encoding", () => {
  it("keeps letters, digits and inner dashes, and round-trips anything", () => {
    expect(ciEncodeTagValue("org-org_01H")).toBe("org-org_5f01H");
    expect(ciEncodeTagValue("-a.b-")).toBe("_2da_2eb_2d");
    for (const value of ["", "a", "org_x", "a/b c", "ünï", "_5f", "-", "x-y-z", "1.2.3"]) {
      const encoded = ciEncodeTagValue(value);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      if (/^[A-Za-z0-9]/.test(value)) expect(encoded).toMatch(/^[A-Za-z0-9](.*[A-Za-z0-9])?$/);
      expect(ciDecodeTagValue(encoded)).toBe(value);
    }
  });

  it("writes string tags with markers and reads them back as sent", () => {
    const strings = ciTagStrings(tags);
    expect(strings).toContain("iwci");
    expect(strings).toContain("iwci:org-org_5f01HZX4Q8W2M3N5P6R7S8T9V0WX");
    expect(strings).toContain("iwci-job:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    for (const s of strings) expect(s.length).toBeLessThanOrEqual(50);
    expect(ciTagsFromStrings([...strings, "prod", "team:web"])).toEqual(tags);
    expect(ciTagMarker("infrawrench-ci")).toBe("iwci");
    expect(ciTagsFromStrings(["iwci"])).toEqual({ "infrawrench-ci": "" });
  });
});

describe("ciHttpStatus", () => {
  it("reads a status from the error or its message", () => {
    expect(ciHttpStatus(Object.assign(new Error("x"), { status: 404 }))).toBe(404);
    expect(ciHttpStatus(Object.assign(new Error("x"), { statusCode: 403 }))).toBe(403);
    expect(ciHttpStatus(new Error("Hetzner API error 422 for /servers: {}"))).toBe(422);
    expect(ciHttpStatus(new Error("nothing"))).toBeUndefined();
  });
});

describe("throwaway credentials", () => {
  it("makes a strong password", () => {
    const a = ciThrowawayPassword();
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/!/);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(ciThrowawayPassword()).not.toBe(a);
  });

  it("makes an OpenSSH ed25519 public key", async () => {
    const key = await ciThrowawaySshKey("iwci-x");
    const [type, blob, comment] = key.split(" ");
    expect(type).toBe("ssh-ed25519");
    expect(comment).toBe("iwci-x");
    const bytes = base64ToBytes(blob ?? "");
    expect(bytes.length).toBe(4 + 11 + 4 + 32);
    expect(new TextDecoder().decode(bytes.slice(4, 15))).toBe("ssh-ed25519");
  });
});
