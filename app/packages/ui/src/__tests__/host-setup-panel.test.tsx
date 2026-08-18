import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type {
  HostPreflight,
  InstallOutcome,
  InstallPlan,
  RequirementId,
  RequirementStatus,
} from "@infrawrench/appstream-core";

import { HostSetupPanel } from "../apps/HostSetupPanel.js";
import { useHostSetup, type HostSetupTransport } from "../apps/use-host-setup.js";

const requirement = (
  id: RequirementId,
  ok: boolean,
  severity: "required" | "recommended" = "required",
): RequirementStatus => ({ id, ok, severity, title: id, summary: `${id} summary` });

function preflight(overrides: Partial<HostPreflight> = {}): HostPreflight {
  const requirements = overrides.requirements ?? [
    requirement("gzip", true),
    requirement("xkb", false),
    requirement("dbus", false),
    requirement("fonts", true),
    requirement("mesa", false, "recommended"),
  ];
  const staging = overrides.staging ?? true;
  return {
    arch: "x86_64",
    osId: "debian",
    osName: "Debian GNU/Linux 13 (trixie)",
    packageManager: "apt-get",
    privilege: "root",
    appCount: 4,
    ...overrides,
    requirements,
    staging,
    ready:
      overrides.ready ??
      (staging && requirements.every((req) => req.severity !== "required" || req.ok)),
  };
}

const plan = (overrides: Partial<InstallPlan> = {}): InstallPlan => ({
  packageManager: "apt-get",
  privilege: "root",
  requirements: ["xkb", "dbus"],
  packages: ["xkb-data", "dbus"],
  commands: ["apt-get update -qq", "apt-get install -y xkb-data dbus"],
  canInstall: true,
  ...overrides,
});

describe("HostSetupPanel", () => {
  const noop = {
    onInstall: async () => {},
    onRecheck: () => {},
    onContinueAnyway: () => {},
  };

  it("says what breaks rather than which package is absent", () => {
    render(<HostSetupPanel preflight={preflight()} plan={plan()} {...noop} />);

    // The user is deciding about consequences, not package names.
    expect(screen.getByText(/the keyboard does nothing/i)).toBeInTheDocument();
    expect(screen.getByText(/wait for one before showing a window/i)).toBeInTheDocument();
  });

  it("shows exactly what will run before offering the button", () => {
    // This installs packages as root on a machine that is not ours; the honest
    // version of that offer is visible in full first.
    render(<HostSetupPanel preflight={preflight()} plan={plan()} {...noop} />);

    expect(screen.getByText(/apt-get install -y xkb-data dbus/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /install what's missing/i })).toBeEnabled();
  });

  it("installs the optional pieces alongside by default, and can be told not to", () => {
    const onInstall = vi.fn(async () => {});
    render(
      <HostSetupPanel preflight={preflight()} plan={plan()} {...noop} onInstall={onInstall} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /install what's missing/i }));
    expect(onInstall).toHaveBeenCalledWith(["xkb", "dbus", "mesa"]);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /install what's missing/i }));
    expect(onInstall).toHaveBeenLastCalledWith(["xkb", "dbus"]);
  });

  it("offers no button on a host it cannot install on, only the commands", () => {
    render(
      <HostSetupPanel
        preflight={preflight({ privilege: "sudo-password" })}
        plan={plan({
          canInstall: false,
          blockedReason: "This login needs a password for sudo.",
          commands: ["sudo apt-get install -y xkb-data"],
        })}
        {...noop}
      />,
    );

    expect(screen.queryByRole("button", { name: /install what's missing/i })).toBeNull();
    expect(screen.getByText(/sudo apt-get install -y xkb-data/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/run the commands above over SSH/i);
  });

  it("says a noexec host cannot be fixed by installing anything", () => {
    render(
      <HostSetupPanel
        preflight={preflight({ staging: false, requirements: [requirement("gzip", true)] })}
        plan={null}
        {...noop}
      />,
    );

    expect(screen.getByText(/mounted noexec/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install what's missing/i })).toBeNull();
  });

  it("always offers a way past itself", () => {
    // The check can be wrong about an unusual host, and being refused by
    // software that will not let you try is worse than a session that fails.
    const onContinueAnyway = vi.fn();
    render(
      <HostSetupPanel
        preflight={preflight()}
        plan={plan()}
        {...noop}
        onContinueAnyway={onContinueAnyway}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open anyway/i }));
    expect(onContinueAnyway).toHaveBeenCalled();
  });

  it("shows the package manager's output", () => {
    render(
      <HostSetupPanel
        preflight={preflight()}
        plan={plan()}
        {...noop}
        installing
        log={["$ apt-get update -qq", "Setting up xkb-data (2.42-1)"]}
      />,
    );

    expect(screen.getByText(/Setting up xkb-data/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /installing/i })).toBeDisabled();
  });
});

describe("useHostSetup", () => {
  const transportFor = (
    check: () => Promise<{ preflight: HostPreflight; plan: InstallPlan | null }>,
    install?: HostSetupTransport["install"],
  ): HostSetupTransport => ({ check, install: install ?? (async () => outcome()) });

  const outcome = (overrides: Partial<InstallOutcome> = {}): InstallOutcome => ({
    log: [],
    failed: [],
    preflight: preflight({ requirements: [requirement("gzip", true)] }),
    ...overrides,
  });

  it("does not block while the check is still running", async () => {
    // Gating the session on an unanswered check would cost every launcher open
    // a round trip, for a prompt almost nobody sees.
    let release: (value: { preflight: HostPreflight; plan: InstallPlan | null }) => void = () => {};
    const pending = new Promise<{ preflight: HostPreflight; plan: InstallPlan | null }>(
      (resolve) => {
        release = resolve;
      },
    );
    const { result } = renderHook(() =>
      useHostSetup(
        transportFor(() => pending),
        "host",
      ),
    );

    expect(result.current.blocked).toBe(false);

    await act(async () => {
      release({ preflight: preflight(), plan: plan() });
      await pending;
    });
    expect(result.current.blocked).toBe(true);
  });

  it("does not block a ready host at all", async () => {
    const ready = preflight({ requirements: [requirement("gzip", true)] });
    const { result } = renderHook(() =>
      useHostSetup(
        transportFor(async () => ({ preflight: ready, plan: null })),
        "host",
      ),
    );

    await waitFor(() => expect(result.current.preflight).toBe(ready));
    expect(result.current.blocked).toBe(false);
  });

  it("does not block when the check itself could not run", async () => {
    // A broken SSH connection is not a host missing everything. Blocking on it
    // would replace the real error with a misleading checklist.
    const { result } = renderHook(() =>
      useHostSetup(
        transportFor(() =>
          Promise.reject(new Error("All configured authentication methods failed")),
        ),
        "host",
      ),
    );

    await waitFor(() => expect(result.current.error).toMatch(/authentication methods failed/));
    expect(result.current.blocked).toBe(false);
  });

  it("stops blocking once an install makes the host ready", async () => {
    const short = { preflight: preflight(), plan: plan() };
    const ready = {
      preflight: preflight({ requirements: [requirement("gzip", true)] }),
      plan: null,
    };
    let calls = 0;
    const { result } = renderHook(() =>
      useHostSetup(
        transportFor(
          async () => (calls++ === 0 ? short : ready),
          async () => outcome({ log: ["Setting up dbus"] }),
        ),
        "host",
      ),
    );

    await waitFor(() => expect(result.current.blocked).toBe(true));
    await act(async () => {
      await result.current.install(["xkb", "dbus"]);
    });

    expect(result.current.log).toEqual(["Setting up dbus"]);
    // The verdict comes from the re-check, not from the install having returned.
    expect(result.current.blocked).toBe(false);
  });

  it("names a package that would not install rather than counting them", async () => {
    const { result } = renderHook(() =>
      useHostSetup(
        transportFor(
          async () => ({ preflight: preflight(), plan: plan() }),
          async () => outcome({ failed: ["dejavu-fonts"], preflight: preflight({ ready: false }) }),
        ),
        "host",
      ),
    );

    await waitFor(() => expect(result.current.blocked).toBe(true));
    await act(async () => {
      await result.current.install(["fonts"]);
    });

    expect(result.current.error).toBe("Could not install: dejavu-fonts");
    // Still short, so still in the way — reported honestly rather than as done.
    expect(result.current.blocked).toBe(true);
  });

  it("clears the previous attempt's output so 'did it work' stays answerable", async () => {
    let installs = 0;
    const { result } = renderHook(() =>
      useHostSetup(
        transportFor(
          async () => ({ preflight: preflight({ ready: false }), plan: plan() }),
          async (_requirements, onOutput) => {
            installs += 1;
            onOutput(`attempt ${installs}`);
            return outcome({
              log: [`attempt ${installs}`],
              preflight: preflight({ ready: false }),
            });
          },
        ),
        "host",
      ),
    );

    await waitFor(() => expect(result.current.blocked).toBe(true));
    await act(async () => {
      await result.current.install(["dbus"]);
    });
    await act(async () => {
      await result.current.install(["dbus"]);
    });

    expect(result.current.log).toEqual(["attempt 2"]);
  });

  it("checks nothing when there is nothing to check against", () => {
    const { result } = renderHook(() => useHostSetup(null, null));

    expect(result.current.preflight).toBeNull();
    expect(result.current.blocked).toBe(false);
  });
});
