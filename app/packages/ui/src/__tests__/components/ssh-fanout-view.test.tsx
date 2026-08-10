import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SshFanoutView, type SshFanoutTargetInfo } from "../../components/SshFanoutView.js";

function target(overrides: Partial<SshFanoutTargetInfo> & { id: string }): SshFanoutTargetInfo {
  return {
    kind: "account",
    label: overrides.id,
    pluginId: "ssh",
    running: true,
    needsKey: false,
    tags: [],
    ...overrides,
  };
}

const targets = [
  target({ id: "a", label: "web-01" }),
  target({ id: "b", label: "web-02" }),
  target({
    id: "r1",
    kind: "resource",
    label: "vm-01",
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    needsKey: true,
    host: "203.0.113.9",
  }),
];

describe("SshFanoutView", () => {
  it("names the host count in the confirm step before executing", async () => {
    const onRun = vi.fn().mockResolvedValue({ kind: "results", results: [] });
    render(<SshFanoutView targets={targets} sshKeys={[]} snippets={[]} onRun={onRun} />);

    fireEvent.click(screen.getByLabelText(/web-01/));
    fireEvent.click(screen.getByLabelText(/web-02/));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "uname -r" } });
    fireEvent.click(screen.getByRole("button", { name: "Run command…" }));

    expect(screen.getByText("Run on 2 hosts?")).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run on 2 hosts" }));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({
      command: "uname -r",
      overrideFreeze: false,
    });
    expect(onRun.mock.calls[0]?.[0].targets).toHaveLength(2);
  });

  it("requires an SSH key before quick-connect targets can run", () => {
    const onRun = vi.fn();
    render(
      <SshFanoutView
        targets={targets}
        sshKeys={[{ id: "k1", name: "ops" }]}
        snippets={[]}
        onRun={onRun}
      />,
    );
    fireEvent.click(screen.getByLabelText(/vm-01/));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "uptime" } });
    expect(screen.getByRole("button", { name: "Run command…" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("SSH key"), { target: { value: "k1" } });
    expect(screen.getByRole("button", { name: "Run command…" })).toBeEnabled();
  });

  it("filters hosts by search text", () => {
    render(<SshFanoutView targets={targets} sshKeys={[]} snippets={[]} onRun={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search hosts"), { target: { value: "vm-0" } });
    expect(screen.queryByText("web-01")).not.toBeInTheDocument();
    expect(screen.getByText("vm-01")).toBeInTheDocument();
  });

  it("shows the freeze warning with an override affordance", async () => {
    const onRun = vi
      .fn()
      .mockResolvedValueOnce({ kind: "freeze", message: "Change freeze in effect" })
      .mockResolvedValueOnce({ kind: "results", results: [] });
    render(<SshFanoutView targets={targets} sshKeys={[]} snippets={[]} onRun={onRun} />);

    fireEvent.click(screen.getByLabelText(/web-01/));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "reboot" } });
    fireEvent.click(screen.getByRole("button", { name: "Run command…" }));
    fireEvent.click(screen.getByRole("button", { name: "Run on 1 host" }));

    await waitFor(() => expect(screen.getByText("Change freeze in effect")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Override freeze and run" }));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2));
    expect(onRun.mock.calls[1]?.[0]).toMatchObject({ overrideFreeze: true });
  });

  it("groups results and diffs the outlier against the majority", async () => {
    const onRun = vi.fn().mockResolvedValue({
      kind: "results",
      results: [
        {
          targetId: "a",
          label: "web-01",
          status: "done",
          exitCode: 0,
          stdout: "6.8.0\n",
          stderr: "",
        },
        {
          targetId: "b",
          label: "web-02",
          status: "done",
          exitCode: 0,
          stdout: "6.8.0\n",
          stderr: "",
        },
        {
          targetId: "c",
          label: "web-03",
          status: "done",
          exitCode: 0,
          stdout: "5.10.0\n",
          stderr: "",
        },
      ],
    });
    render(<SshFanoutView targets={targets} sshKeys={[]} snippets={[]} onRun={onRun} />);
    fireEvent.click(screen.getByLabelText(/web-01/));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "uname -r" } });
    fireEvent.click(screen.getByRole("button", { name: "Run command…" }));
    fireEvent.click(screen.getByRole("button", { name: "Run on 1 host" }));

    await waitFor(() => expect(screen.getByText("majority")).toBeInTheDocument());
    expect(screen.getByText("outlier")).toBeInTheDocument();
    expect(screen.getByText("2 hosts")).toBeInTheDocument();
    expect(screen.getByText("+ 5.10.0")).toBeInTheDocument();
    expect(screen.getByText("- 6.8.0")).toBeInTheDocument();
  });

  it("confirms before deleting a snippet and reports a failed deletion", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const onDeleteSnippet = vi.fn().mockRejectedValue(new Error("delete failed"));
      render(
        <SshFanoutView
          targets={targets}
          sshKeys={[]}
          snippets={[{ id: "s1", name: "kernel", command: "uname -r" }]}
          onRun={vi.fn()}
          onDeleteSnippet={onDeleteSnippet}
        />,
      );

      fireEvent.change(screen.getByLabelText("Delete saved snippet"), { target: { value: "s1" } });
      expect(confirmSpy).toHaveBeenCalledWith('Delete snippet "kernel"?');
      expect(onDeleteSnippet).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      fireEvent.change(screen.getByLabelText("Delete saved snippet"), { target: { value: "s1" } });
      expect(onDeleteSnippet).toHaveBeenCalledWith("s1");
      await waitFor(() => expect(screen.getByText("delete failed")).toBeInTheDocument());
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("inserts a saved snippet into the command box", () => {
    render(
      <SshFanoutView
        targets={targets}
        sshKeys={[]}
        snippets={[{ id: "s1", name: "kernel", command: "uname -r" }]}
        onRun={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Insert saved snippet"), { target: { value: "s1" } });
    expect(screen.getByLabelText("Command")).toHaveValue("uname -r");
  });
});
