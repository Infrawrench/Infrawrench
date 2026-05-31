import { describe, it, expect, vi } from "vitest";
import {
  instanceTypeArch,
  isImageFamily,
  FAMILY_SSH_USERNAME,
  resolveAmiId,
} from "../ami-lookup.js";
import type { AwsCreateContext } from "../create-handlers/shared.js";

describe("instanceTypeArch", () => {
  it("detects arm64 graviton families and a1", () => {
    expect(instanceTypeArch("t4g.small")).toBe("arm64");
    expect(instanceTypeArch("m6gd.large")).toBe("arm64");
    expect(instanceTypeArch("c7gn.xlarge")).toBe("arm64");
    expect(instanceTypeArch("a1.medium")).toBe("arm64");
  });
  it("defaults to x86_64", () => {
    expect(instanceTypeArch("t3.micro")).toBe("x86_64");
    expect(instanceTypeArch("m6i.large")).toBe("x86_64");
    expect(instanceTypeArch("")).toBe("x86_64");
  });
});

describe("isImageFamily", () => {
  it("recognizes known families", () => {
    expect(isImageFamily("al2023")).toBe(true);
    expect(isImageFamily("ubuntu-2204")).toBe(true);
    expect(isImageFamily("nonsense")).toBe(false);
  });
  it("FAMILY_SSH_USERNAME covers each family", () => {
    expect(FAMILY_SSH_USERNAME["debian-12"]).toBe("admin");
    expect(FAMILY_SSH_USERNAME["al2023"]).toBe("ec2-user");
  });
});

function ctx(over: Partial<AwsCreateContext> = {}): AwsCreateContext {
  return {
    json: vi.fn(async () => ({})),
    ec2: vi.fn(async () => ({})),
    ...over,
  } as unknown as AwsCreateContext;
}

describe("resolveAmiId via SSM", () => {
  it("resolves al2023 x86_64 through the SSM parameter", async () => {
    const json = vi.fn(async () => ({ Parameter: { Value: "ami-123" } }));
    const out = await resolveAmiId(ctx({ json: json as never }), "al2023", "x86_64");
    expect(out).toBe("ami-123");
    expect(((json.mock.calls as unknown as unknown[][])[0]![2] as { Name: string }).Name).toContain(
      "al2023-ami-kernel-default-x86_64",
    );
  });
  it("resolves ubuntu-2404 arm64 (amd64/arm64 mapping)", async () => {
    const json = vi.fn(async () => ({ Parameter: { Value: "ami-arm" } }));
    await resolveAmiId(ctx({ json: json as never }), "ubuntu-2404", "arm64");
    expect(((json.mock.calls as unknown as unknown[][])[0]![2] as { Name: string }).Name).toContain(
      "/arm64/",
    );
  });
  it("resolves debian families", async () => {
    const json = vi.fn(async () => ({ Parameter: { Value: "ami-d" } }));
    await resolveAmiId(ctx({ json: json as never }), "debian-12", "x86_64");
    expect(((json.mock.calls as unknown as unknown[][])[0]![2] as { Name: string }).Name).toContain(
      "bookworm",
    );
    const json2 = vi.fn(async () => ({ Parameter: { Value: "ami-d2" } }));
    await resolveAmiId(ctx({ json: json2 as never }), "debian-13", "arm64");
    expect(
      ((json2.mock.calls as unknown as unknown[][])[0]![2] as { Name: string }).Name,
    ).toContain("/release/13/");
  });
  it("throws when SSM returns no value", async () => {
    await expect(
      resolveAmiId(
        ctx({ json: vi.fn(async () => ({ Parameter: {} })) as never }),
        "amzn2",
        "x86_64",
      ),
    ).rejects.toThrow(/no value/);
  });
});

describe("resolveAmiId via DescribeImages", () => {
  it("picks the newest RHEL image", async () => {
    const ec2 = vi.fn(async () => ({
      imagesSet: {
        item: [
          { imageId: "ami-old", creationDate: "2023-01-01" },
          { imageId: "ami-new", creationDate: "2024-01-01" },
        ],
      },
    }));
    const out = await resolveAmiId(ctx({ ec2: ec2 as never }), "rhel-9", "x86_64");
    expect(out).toBe("ami-new");
  });
  it("resolves rhel-10 and sles-15", async () => {
    const ec2 = vi.fn(async () => ({
      imagesSet: { item: { imageId: "ami-x", creationDate: "2025" } },
    }));
    expect(await resolveAmiId(ctx({ ec2: ec2 as never }), "rhel-10", "arm64")).toBe("ami-x");
    expect(await resolveAmiId(ctx({ ec2: ec2 as never }), "sles-15", "x86_64")).toBe("ami-x");
  });
  it("throws when no images found", async () => {
    const ec2 = vi.fn(async () => ({ imagesSet: {} }));
    await expect(resolveAmiId(ctx({ ec2: ec2 as never }), "rhel-9", "x86_64")).rejects.toThrow(
      /No AMIs found/,
    );
  });
});
