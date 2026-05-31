import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DescribeView } from "../../components/detail/DescribeView.js";
import { LogsView } from "../../components/detail/LogsView.js";
import type { DescribeCapability, LogsCapability, LogsFetchResult } from "@infrawrench/plugin-base";

const describeCap = { language: "yaml" } as DescribeCapability;

describe("DescribeView", () => {
  it("shows a loading state then the describe text", async () => {
    const onGetDescribe = vi.fn().mockResolvedValue("apiVersion: v1");
    render(<DescribeView capability={describeCap} onGetDescribe={onGetDescribe} />);
    expect(screen.getByText("Loading describe…")).toBeInTheDocument();
    expect(await screen.findByText("apiVersion: v1")).toBeInTheDocument();
    expect(screen.getByText("yaml")).toBeInTheDocument();
  });

  it("shows an error with a retry button that refetches", async () => {
    const onGetDescribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("describe failed"))
      .mockResolvedValueOnce("ok-now");
    render(<DescribeView capability={describeCap} onGetDescribe={onGetDescribe} />);
    expect(await screen.findByText(/describe failed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ok-now")).toBeInTheDocument();
  });

  it("reload refetches the describe text", async () => {
    const onGetDescribe = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    render(<DescribeView capability={describeCap} onGetDescribe={onGetDescribe} />);
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("second")).toBeInTheDocument();
  });

  it("defaults the language label to text", async () => {
    const onGetDescribe = vi.fn().mockResolvedValue("x");
    render(<DescribeView capability={{} as DescribeCapability} onGetDescribe={onGetDescribe} />);
    await screen.findByText("x");
    expect(screen.getByText("text")).toBeInTheDocument();
  });
});

function logsResult(partial: Partial<LogsFetchResult> = {}): LogsFetchResult {
  return {
    text: "log line 1\nlog line 2",
    containers: ["app"],
    activeContainer: "app",
    ...partial,
  } as LogsFetchResult;
}

describe("LogsView", () => {
  const cap = { defaultTailLines: 500, supportsPrevious: true } as LogsCapability;

  it("renders fetched log output", async () => {
    const onGetLogs = vi.fn().mockResolvedValue(logsResult());
    render(<LogsView capability={cap} onGetLogs={onGetLogs} />);
    expect(await screen.findByText(/log line 1/)).toBeInTheDocument();
  });

  it("renders a container selector when multiple containers exist", async () => {
    const onGetLogs = vi
      .fn()
      .mockResolvedValue(logsResult({ containers: ["app", "sidecar"], activeContainer: "app" }));
    render(<LogsView capability={cap} onGetLogs={onGetLogs} />);
    await screen.findByText(/log line 1/);
    expect(screen.getByTitle("Container")).toBeInTheDocument();
  });

  it("changes tail lines and refetches", async () => {
    const onGetLogs = vi.fn().mockResolvedValue(logsResult());
    render(<LogsView capability={cap} onGetLogs={onGetLogs} />);
    await screen.findByText(/log line 1/);
    onGetLogs.mockClear();
    fireEvent.change(screen.getByTitle("Tail lines"), { target: { value: "1000" } });
    await waitFor(() =>
      expect(onGetLogs).toHaveBeenCalledWith(expect.objectContaining({ tailLines: 1000 })),
    );
  });

  it("toggles previous and refetches with the flag", async () => {
    const onGetLogs = vi.fn().mockResolvedValue(logsResult());
    render(<LogsView capability={cap} onGetLogs={onGetLogs} />);
    await screen.findByText(/log line 1/);
    onGetLogs.mockClear();
    fireEvent.click(screen.getByLabelText("Previous"));
    await waitFor(() =>
      expect(onGetLogs).toHaveBeenCalledWith(expect.objectContaining({ previous: true })),
    );
  });

  it("surfaces an error from the logs fetch", async () => {
    const onGetLogs = vi.fn().mockRejectedValue(new Error("logs boom"));
    render(<LogsView capability={cap} onGetLogs={onGetLogs} />);
    expect(await screen.findByText(/logs boom/)).toBeInTheDocument();
  });

  it("hides the previous toggle when not supported", async () => {
    const onGetLogs = vi.fn().mockResolvedValue(logsResult());
    render(
      <LogsView capability={{ defaultTailLines: 100 } as LogsCapability} onGetLogs={onGetLogs} />,
    );
    await screen.findByText(/log line 1/);
    expect(screen.queryByLabelText("Previous")).not.toBeInTheDocument();
  });
});
