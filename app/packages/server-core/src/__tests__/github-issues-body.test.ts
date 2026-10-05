import { describe, expect, it, vi } from "vitest";

// The body builder is pure; keep the module's database imports inert.
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../db/client.js", () => ({ db: {} }));

const { buildGithubIssueBody, findingFingerprint, findingMarker } =
  await import("../github-issues/filing");

describe("findingFingerprint", () => {
  it("is stable and org-scoped", () => {
    const a = findingFingerprint("org-1", "orphan", "res-1");
    expect(a).toBe(findingFingerprint("org-1", "orphan", "res-1"));
    expect(a).not.toBe(findingFingerprint("org-2", "orphan", "res-1"));
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("buildGithubIssueBody", () => {
  it("carries the marker, an evidence table, cost, remediation and Terraform", () => {
    const body = buildGithubIssueBody(
      {
        sourceKind: "orphan",
        sourceId: "res-1",
        title: "vol-1 (EBS Volume) looks orphaned",
        details: [
          { label: "Resource", value: "vol | 1" },
          { label: "Empty", value: "" },
        ],
        note: "Volume is not attached.",
        monthlyCost: { amount: 12.5, currency: "USD" },
        remediation: ["aws ec2 delete-volume --volume-id vol-1"],
        appUrl: "https://app.example.test/org/o/savings",
      },
      {
        fingerprint: "abc",
        autoFiled: true,
        terraform: { address: "aws_ebs_volume.scratch", stateLabel: "prod" },
      },
    );
    expect(body.startsWith(`<!-- ${findingMarker("abc")} -->`)).toBe(true);
    expect(body).toContain("| Resource | vol \\| 1 |");
    expect(body).not.toContain("| Empty |");
    expect(body).toContain("| Monthly cost | $12.50 |");
    expect(body).toContain("```sh\naws ec2 delete-volume --volume-id vol-1\n```");
    expect(body).toContain("`aws_ebs_volume.scratch`");
    expect(body).toContain("Filed automatically by an Infrawrench alert routing rule.");
  });
});
