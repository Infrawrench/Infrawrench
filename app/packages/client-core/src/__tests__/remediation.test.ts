import { describe, expect, it } from "vitest";
import { buildJiraIssueDraft } from "../jira";
import {
  hasRemediation,
  orderedRemediationCommands,
  remediationCommandLines,
  remediationIssueText,
  remediationScript,
  remediationToolLabel,
  type FindingRemediation,
} from "../remediation";

const remediation: FindingRemediation = {
  commands: [
    {
      tool: "aws-cli",
      command:
        'aws ec2 create-snapshot --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE"',
      description: "Snapshot the volume before deleting it.",
      destructive: false,
    },
    {
      tool: "aws-cli",
      command:
        'aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE"',
      description: "Delete the detached volume.",
      destructive: true,
    },
  ],
  placeholders: [{ name: "AWS_PROFILE", description: "AWS CLI profile for this account" }],
  iac: null,
};

const managed: FindingRemediation = {
  ...remediation,
  iac: {
    address: "aws_ebs_volume.data",
    stateLabel: "prod",
    attributeChanges: [],
    commands: [
      {
        tool: "terraform",
        command: "terraform plan -destroy -target=aws_ebs_volume.data",
        description: "Preview destroying aws_ebs_volume.data.",
        destructive: false,
      },
    ],
  },
};

describe("remediation helpers", () => {
  it("knows when there is nothing to show", () => {
    expect(hasRemediation(undefined)).toBe(false);
    expect(hasRemediation({ commands: [], placeholders: [], iac: null })).toBe(false);
    expect(hasRemediation(remediation)).toBe(true);
  });

  it("puts the Terraform hint ahead of the CLI commands", () => {
    expect(orderedRemediationCommands(managed).map((c) => c.tool)).toEqual([
      "terraform",
      "aws-cli",
      "aws-cli",
    ]);
  });

  it("labels known tools and passes unknown ones through", () => {
    expect(remediationToolLabel("aws-cli")).toBe("AWS CLI");
    expect(remediationToolLabel("exoscale")).toBe("exoscale");
  });

  it("builds a copy-all script with placeholders and destructive markers", () => {
    expect(remediationScript(remediation)).toMatchInlineSnapshot(`
      "# export AWS_PROFILE=...   # AWS CLI profile for this account
      # Snapshot the volume before deleting it.
      aws ec2 create-snapshot --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE"
      # [DESTRUCTIVE] Delete the detached volume.
      aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE""
    `);
  });

  it("renders a tracker-neutral issue section with one fence per command", () => {
    const text = remediationIssueText(managed);
    expect(text).toMatchInlineSnapshot(`
      "Remediation

      Managed by Terraform at aws_ebs_volume.data (state: prod). Change the configuration instead of running the CLI commands, or the next apply reverts them.

      Set first:
      - AWS_PROFILE: AWS CLI profile for this account

      1. Preview destroying aws_ebs_volume.data. (Terraform)

      \`\`\`sh
      terraform plan -destroy -target=aws_ebs_volume.data
      \`\`\`

      2. Snapshot the volume before deleting it. (AWS CLI)

      \`\`\`sh
      aws ec2 create-snapshot --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE"
      \`\`\`

      3. Destructive: Delete the detached volume. (AWS CLI)

      \`\`\`sh
      aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE"
      \`\`\`"
    `);
    expect(remediationIssueText(undefined)).toBe("");
  });

  it("appends the section to issue drafts", () => {
    const draft = buildJiraIssueDraft({
      sourceKind: "orphan",
      title: "data (EBS Volume) looks orphaned",
      note: "EBS volume is detached",
      remediation,
    });
    expect(draft.description).toContain("Remediation\n\n");
    expect(draft.description).toContain("```sh\naws ec2 delete-volume");
    expect(draft.description.endsWith("Filed from Infrawrench.")).toBe(true);
  });
});

describe("remediationCommandLines", () => {
  it("lists bare commands in reading order, Terraform first", () => {
    expect(remediationCommandLines(remediation)).toEqual(
      remediation.commands.map((c) => c.command),
    );
    const lines = remediationCommandLines(managed);
    expect(lines[0]).toBe(managed.iac!.commands[0]!.command);
    expect(lines).toHaveLength(managed.iac!.commands.length + remediation.commands.length);
  });

  it("drops what the GitHub route would refuse rather than cutting a command", () => {
    const long = { ...remediation.commands[0]!, command: `echo ${"x".repeat(2_000)}` };
    const many: FindingRemediation = {
      ...remediation,
      commands: [long, ...Array.from({ length: 30 }, () => remediation.commands[1]!)],
    };
    const lines = remediationCommandLines(many);
    expect(lines).toHaveLength(20);
    expect(lines.every((l) => l.length <= 2_000)).toBe(true);
    expect(remediationCommandLines(null)).toEqual([]);
  });
});
