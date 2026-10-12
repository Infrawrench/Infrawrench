import * as vscode from "vscode";
import { estimateWorkingTree } from "./diff-estimate";
import { IacIndexService } from "./iac-index";
import { openResource, openService, openVulnerabilities, type OpenResourceArgs } from "./open";
import { clearSearchCache, runSearch } from "./search";
import { ServicesTreeProvider } from "./services-tree";
import { Session } from "./session";
import {
  TERRAFORM_SELECTOR,
  TerraformCodeLensProvider,
  TerraformHoverProvider,
  createSectionCaches,
  type NamedOpenArgs,
} from "./terraform";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const session = new Session(context);
  const iac = new IacIndexService(session);
  const caches = createSectionCaches();
  const codeLens = new TerraformCodeLensProvider(session, iac, caches);
  const services = new ServicesTreeProvider(session);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "infrawrench.selectOrg";
  const renderStatus = () => {
    if (session.orgId) {
      status.text = `$(tools) ${session.orgName ?? "Infrawrench"}`;
      status.tooltip =
        session.mode === "apiKey"
          ? `Infrawrench: API key for organization ${session.orgId}`
          : "Infrawrench: switch organization";
    } else {
      status.text = "$(tools) Infrawrench: sign in";
      status.tooltip = "Sign in to Infrawrench";
      status.command = "infrawrench.signIn";
    }
    status.show();
  };

  const resetCaches = () => {
    caches.posture.clear();
    caches.perResource.clear();
    clearSearchCache();
    iac.refresh();
  };
  session.onDidChange(() => {
    status.command = "infrawrench.selectOrg";
    resetCaches();
    renderStatus();
  });

  /** Commands surface failures as messages rather than as silent rejections. */
  const command = (id: string, fn: (...args: never[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        await fn(...args);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Infrawrench: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

  context.subscriptions.push(
    session,
    iac,
    status,
    vscode.languages.registerHoverProvider(
      TERRAFORM_SELECTOR,
      new TerraformHoverProvider(session, iac, caches),
    ),
    vscode.languages.registerCodeLensProvider(TERRAFORM_SELECTOR, codeLens),
    vscode.window.registerTreeDataProvider("infrawrench.services", services),
    command("infrawrench.signIn", () => session.signIn()),
    command("infrawrench.signOut", () => session.signOut()),
    command("infrawrench.selectOrg", () => session.selectOrg()),
    command("infrawrench.search", () => runSearch(session)),
    command("infrawrench.estimateDiff", () => estimateWorkingTree(session)),
    command("infrawrench.refresh", () => {
      resetCaches();
      services.refresh();
      codeLens.refresh();
    }),
    command("infrawrench.openResource", (args: OpenResourceArgs) => openResource(session, args)),
    command("infrawrench.openService", (args: { id: string }) => openService(session, args.id)),
    command("infrawrench.openVulnerabilities", () => openVulnerabilities(session)),
    command("infrawrench.copyText", async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage("Copied", 2000);
    }),
    command("infrawrench.openBlock", async (targets: NamedOpenArgs[]) => {
      const target =
        targets.length === 1
          ? targets[0]
          : (
              await vscode.window.showQuickPick(
                targets.map((t) => ({ label: t.displayName, description: t.address, t })),
                { title: "Open which resource?" },
              )
            )?.t;
      if (target) await openResource(session, target);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("infrawrench.cloudUrl")) void session.restore();
      if (e.affectsConfiguration("infrawrench.codeLens")) codeLens.refresh();
    }),
  );

  renderStatus();
  await session.restore();
}

export function deactivate(): void {}
