import * as vscode from "vscode";

export interface ExtensionConfig {
  cloudUrl: string;
  openIn: "web" | "desktop";
  codeLensEnabled: boolean;
  costEstimateRepository: string;
  workosClientId: string;
  workosApiUrl: string;
}

export function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration("infrawrench");
  return {
    cloudUrl: c.get<string>("cloudUrl", "https://app.infrawrench.com").replace(/\/+$/, ""),
    openIn: c.get<"web" | "desktop">("openIn", "web"),
    codeLensEnabled: c.get<boolean>("codeLens.enabled", true),
    costEstimateRepository: c.get<string>("costEstimate.repository", "").trim(),
    workosClientId: c.get<string>("auth.workosClientId", "client_01KY8MAZ7NCYMN6K44G9FFZ5KS"),
    workosApiUrl: c
      .get<string>("auth.workosApiUrl", "https://auth-api.infrawrench.com")
      .replace(/\/+$/, ""),
  };
}
