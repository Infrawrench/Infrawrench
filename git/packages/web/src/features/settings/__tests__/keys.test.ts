import { describe, expect, it } from "vitest";
import { backendConfiguration, suggestWorkspaceName } from "../../infrastructure/backend-snippet";
import { commentOfKey, expiryOf } from "../keys";

describe("commentOfKey", () => {
  it("reads the comment of a public key line", () => {
    expect(commentOfKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA mara@thinkpad")).toBe(
      "mara@thinkpad",
    );
    expect(commentOfKey("  ssh-rsa AAAAB3Nza work laptop \n")).toBe("work laptop");
  });

  it("skips options before the key type", () => {
    expect(commentOfKey('no-pty,command="x" ecdsa-sha2-nistp256 AAAAE2Vj deploy')).toBe("deploy");
  });

  it("answers null without a comment or without a key", () => {
    expect(commentOfKey("ssh-ed25519 AAAAC3Nza")).toBeNull();
    expect(commentOfKey("ssh-ed25519")).toBeNull();
    expect(commentOfKey("not a key at all")).toBeNull();
    expect(commentOfKey("")).toBeNull();
  });
});

describe("expiryOf", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  it("places a token in its life", () => {
    expect(expiryOf(null, now)).toBe("never");
    expect(expiryOf("2026-11-25T11:59:59.000Z", now)).toBe("expired");
    expect(expiryOf("2026-11-28T12:00:00.000Z", now)).toBe("soon");
    expect(expiryOf("2027-01-01T00:00:00.000Z", now)).toBe("later");
  });
});

describe("backendConfiguration", () => {
  it("points Terraform at the workspace's state with POST and DELETE locks", () => {
    expect(
      backendConfiguration(
        "https://git.infrawrench.com/acme/infra/terraform/staging/state",
        "mara",
      ),
    ).toBe(
      [
        "terraform {",
        '  backend "http" {',
        '    address        = "https://git.infrawrench.com/acme/infra/terraform/staging/state"',
        '    lock_address   = "https://git.infrawrench.com/acme/infra/terraform/staging/state/lock"',
        '    unlock_address = "https://git.infrawrench.com/acme/infra/terraform/staging/state/lock"',
        '    lock_method    = "POST"',
        '    unlock_method  = "DELETE"',
        '    username       = "mara"',
        "    # password: a personal access token, in TF_HTTP_PASSWORD",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });
});

describe("suggestWorkspaceName", () => {
  it("takes the root's last directory, and a free name when that is taken", () => {
    expect(suggestWorkspaceName("environments/staging", [])).toBe("staging");
    expect(suggestWorkspaceName("environments/staging", ["staging"])).toBe("staging-2");
    expect(suggestWorkspaceName("environments/staging", ["staging", "staging-2"])).toBe(
      "staging-3",
    );
    expect(suggestWorkspaceName("", [])).toBe("default");
    expect(suggestWorkspaceName("live/eu west", [])).toBe("eu-west");
  });
});
