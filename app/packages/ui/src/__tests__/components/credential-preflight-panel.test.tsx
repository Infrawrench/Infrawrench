import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CredentialPreflightPanel } from "../../components/CredentialPreflightPanel.js";
import type { PolicyTemplate, PreflightDeclaration } from "@infrawrench/client-core";

const declaration: PreflightDeclaration = {
  capabilities: [
    {
      id: "resources",
      label: "Resource inventory",
      requiredPermissions: [{ id: "ec2:DescribeInstances", label: "List EC2 instances" }],
      essential: true,
    },
    {
      id: "costs",
      label: "Cost reporting",
      requiredPermissions: [{ id: "ce:GetCostAndUsage", label: "Read cost data" }],
    },
  ],
  templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
};

function template(document: string): PolicyTemplate {
  return { formatLabel: "AWS IAM policy (JSON)", language: "json", document };
}

describe("CredentialPreflightPanel", () => {
  it("renders every declared capability as unchecked before a run", () => {
    render(<CredentialPreflightPanel declaration={declaration} />);
    expect(screen.getByText("Resource inventory")).toBeInTheDocument();
    expect(screen.getByText("Cost reporting")).toBeInTheDocument();
    expect(screen.getAllByText(/Not checked yet/)).toHaveLength(2);
  });

  it("only applies the latest generate result when requests resolve out of order", async () => {
    let resolveFirst!: (t: PolicyTemplate) => void;
    const first = new Promise<PolicyTemplate>((r) => {
      resolveFirst = r;
    });
    const fetchPolicyTemplate = vi
      .fn<(ids: string[]) => Promise<PolicyTemplate>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => Promise.resolve(template("second")));

    render(
      <CredentialPreflightPanel
        declaration={declaration}
        fetchPolicyTemplate={fetchPolicyTemplate}
      />,
    );

    // Opening the generator fires request 1 (both capabilities selected).
    fireEvent.click(screen.getByText(/Generate least-privilege/));
    // Unticking a capability fires request 2, which resolves first.
    fireEvent.click(screen.getByLabelText("Cost reporting"));
    await waitFor(() => expect(screen.getByText("second")).toBeInTheDocument());

    // Request 1 resolving late must not clobber the newer template.
    resolveFirst(template("first"));
    await waitFor(() => expect(fetchPolicyTemplate).toHaveBeenCalledTimes(2));
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.queryByText("first")).not.toBeInTheDocument();
  });

  it("drops a stale generator error from a superseded request", async () => {
    let rejectFirst!: (e: Error) => void;
    const first = new Promise<PolicyTemplate>((_r, reject) => {
      rejectFirst = reject;
    });
    const fetchPolicyTemplate = vi
      .fn<(ids: string[]) => Promise<PolicyTemplate>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => Promise.resolve(template("second")));

    render(
      <CredentialPreflightPanel
        declaration={declaration}
        fetchPolicyTemplate={fetchPolicyTemplate}
      />,
    );

    fireEvent.click(screen.getByText(/Generate least-privilege/));
    fireEvent.click(screen.getByLabelText("Cost reporting"));
    await waitFor(() => expect(screen.getByText("second")).toBeInTheDocument());

    rejectFirst(new Error("stale failure"));
    await waitFor(() => expect(fetchPolicyTemplate).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/stale failure/)).not.toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });
});
