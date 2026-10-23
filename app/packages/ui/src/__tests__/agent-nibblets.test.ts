import { describe, expect, it } from "vitest";
import {
  buildNibbletsAppLinksFile,
  buildNibbletsAppLinksWriteCommand,
  buildNibbletsBootstrapCommand,
  buildNibbletsSignInCommand,
  createNibbletsSetupPlan,
  NIBBLETS_APP_LINKS_FILE,
} from "../agents/nibblets.js";
import {
  agentSurfaceOrDefault,
  agentSurfaceRequiresRepo,
  agentSurfaceUsesTool,
} from "../agents/t3-code.js";

describe("Nibblets agent sessions", () => {
  it("is its own surface with no repo and no tool", () => {
    expect(agentSurfaceOrDefault("nibblets")).toBe("nibblets");
    expect(agentSurfaceRequiresRepo("nibblets")).toBe(false);
    expect(agentSurfaceUsesTool("nibblets")).toBe(false);
    expect(agentSurfaceUsesTool("t3-code")).toBe(true);
  });

  it("runs the installer non-interactively without blocking on Nibblets Connect", () => {
    const command = buildNibbletsBootstrapCommand({ withAppLinks: false });
    expect(command).toContain("NIBBLETS_YES=1");
    expect(command).toContain("NIBBLETS_CONNECT=0");
    expect(command).toContain("https://nibblets.dev/install.sh");
    expect(command).not.toContain("NIBBLETS_APP_LINKS_FILE");
    expect(command).toContain("Bootstrap complete.");
  });

  it("points the installer at the app-links file only when one was written", () => {
    const command = buildNibbletsBootstrapCommand({ withAppLinks: true });
    expect(command).toContain(`NIBBLETS_APP_LINKS_FILE="$HOME/${NIBBLETS_APP_LINKS_FILE}"`);
    // A failed install must not leave the credential behind.
    expect(command).toContain(`rm -f "$HOME/${NIBBLETS_APP_LINKS_FILE}"`);
  });

  it("keeps the pair link out of what it reports on failure", () => {
    const command = buildNibbletsBootstrapCommand({ withAppLinks: false });
    expect(command).toContain("grep -v");
    expect(command).toContain("#pair=");
  });

  it("writes the credential from stdin, 0600, never from its own arguments", () => {
    const command = buildNibbletsAppLinksWriteCommand();
    expect(command).toContain("umask 077");
    expect(command).toContain("chmod 600");
    expect(command).toContain('cat > "$FILE.tmp"');
    expect(command).not.toContain("iwl_");
  });

  it("builds the file the installer adopts, with the Infrawrench plugin's url setting", () => {
    const parsed = JSON.parse(
      buildNibbletsAppLinksFile({ infrawrenchUrl: "https://iw.example.com/", secret: "iwl_x" }),
    );
    expect(parsed).toEqual([
      { plugin: "infrawrench", settings: { url: "https://iw.example.com" }, secret: "iwl_x" },
    ]);
  });

  it("signs in from the installer's own menu, then says how to reach the UI", () => {
    const command = buildNibbletsSignInCommand();
    expect(command).toContain('bash "$INSTALLER" --sign-in');
    expect(command).toContain("https://app.nibblets.dev");
    expect(command).toContain("8420:127.0.0.1:8420");
  });

  it("describes whether the server starts linked", () => {
    expect(createNibbletsSetupPlan(true).warnings.join(" ")).toContain("starts linked");
    expect(createNibbletsSetupPlan(false).warnings.join(" ")).toContain("not linked");
  });
});
