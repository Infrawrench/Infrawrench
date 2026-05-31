import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsEditorView } from "../../components/detail/SettingsEditorView.js";
import type { SettingsEditorCapability, SettingDescriptor } from "@infrawrench/plugin-base";

const cap = { tabLabel: "Settings", description: "Tune it" } as SettingsEditorCapability;

function manifest(settings: SettingDescriptor[]): string {
  return JSON.stringify({ settings });
}

const SETTINGS: SettingDescriptor[] = [
  { id: "maintenance", label: "Maintenance mode", control: "toggle", value: "off" },
  {
    id: "tier",
    label: "Tier",
    control: "select",
    value: "basic",
    options: [
      { value: "basic", label: "Basic" },
      { value: "pro", label: "Pro" },
    ],
  },
  { id: "replicas", label: "Replicas", control: "number", value: "2" },
  { id: "name", label: "Name", control: "text", value: "db1" },
  { id: "engine", label: "Engine", control: "readonly", value: "postgres" },
] as SettingDescriptor[];

describe("SettingsEditorView", () => {
  it("loads and renders settings controls", async () => {
    const onGetManifest = vi.fn().mockResolvedValue(manifest(SETTINGS));
    render(<SettingsEditorView capability={cap} onGetManifest={onGetManifest} />);
    expect(await screen.findByRole("switch", { name: "Maintenance mode" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Tier" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Replicas" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByText("postgres")).toBeInTheDocument();
  });

  it("shows an error when the manifest fails to load", async () => {
    const onGetManifest = vi.fn().mockRejectedValue(new Error("no manifest"));
    render(<SettingsEditorView capability={cap} onGetManifest={onGetManifest} />);
    expect(await screen.findByText("no manifest")).toBeInTheDocument();
  });

  it("enables Apply only after a change and applies the changed pairs", async () => {
    const onGetManifest = vi.fn().mockResolvedValue(manifest(SETTINGS));
    const onApplyManifest = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsEditorView
        capability={cap}
        onGetManifest={onGetManifest}
        onApplyManifest={onApplyManifest}
      />,
    );
    await screen.findByRole("switch", { name: "Maintenance mode" });
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Maintenance mode" }));
    const apply1 = screen.getByRole("button", { name: "Apply (1)" });
    expect(apply1).toBeEnabled();
    fireEvent.click(apply1);
    await waitFor(() =>
      expect(onApplyManifest).toHaveBeenCalledWith(
        JSON.stringify([{ id: "maintenance", value: "on" }]),
      ),
    );
  });

  it("updates a select value", async () => {
    const onGetManifest = vi.fn().mockResolvedValue(manifest(SETTINGS));
    const onApplyManifest = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsEditorView
        capability={cap}
        onGetManifest={onGetManifest}
        onApplyManifest={onApplyManifest}
      />,
    );
    await screen.findByRole("combobox", { name: "Tier" });
    fireEvent.change(screen.getByRole("combobox", { name: "Tier" }), { target: { value: "pro" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply (1)" }));
    await waitFor(() =>
      expect(onApplyManifest).toHaveBeenCalledWith(JSON.stringify([{ id: "tier", value: "pro" }])),
    );
  });

  it("filters settings by search", async () => {
    const onGetManifest = vi.fn().mockResolvedValue(manifest(SETTINGS));
    render(<SettingsEditorView capability={cap} onGetManifest={onGetManifest} />);
    await screen.findByRole("switch", { name: "Maintenance mode" });
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "tier" } });
    expect(screen.getByRole("combobox", { name: "Tier" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Maintenance mode" })).not.toBeInTheDocument();
  });

  it("shows a no-match message when search excludes everything", async () => {
    const onGetManifest = vi.fn().mockResolvedValue(manifest(SETTINGS));
    render(<SettingsEditorView capability={cap} onGetManifest={onGetManifest} />);
    await screen.findByRole("switch", { name: "Maintenance mode" });
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "zzz" } });
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
  });

  it("renders a no-settings message for an empty manifest", async () => {
    const onGetManifest = vi.fn().mockResolvedValue(manifest([]));
    render(<SettingsEditorView capability={cap} onGetManifest={onGetManifest} />);
    expect(await screen.findByText("No settings.")).toBeInTheDocument();
  });
});
