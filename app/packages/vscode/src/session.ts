import * as crypto from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";
import {
  CloudApiError,
  TokenManager,
  createCloudFetch,
  fetchOrgs,
  parseOrgIdInput,
  staticAccessToken,
  type AccessTokenSource,
  type CloudFetch,
  type TokenStorage,
} from "@infrawrench/client-core";
import { readConfig } from "./config";

/**
 * Who the extension talks to the cloud as, and in which org.
 *
 * Two ways in, both Bearer against the existing API:
 * - **Browser** (WorkOS PKCE): the CLI's loopback redirect
 *   `http://127.0.0.1:43117/callback`, which is already registered on the
 *   WorkOS application, so no server change is needed. Tokens refresh.
 * - **API key** (`iwk_…`): stored in SecretStorage. A key belongs to one org
 *   and `/api/auth/orgs` does not accept keys, so the org is typed (or a web
 *   URL inside it pasted) and then verified with a read.
 *
 * Secrets live only in `context.secrets`; the mode and the chosen org live in
 * `globalState`, which is not secret.
 */

export type AuthMode = "browser" | "apiKey";

const LOGIN_PORT = 43117;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const API_KEY_SECRET = "infrawrench.apiKey";
const WORKOS_SECRET_PREFIX = "infrawrench.workos.";
const STATE_KEY = "infrawrench.session";

interface StoredSession {
  mode: AuthMode;
  cloudUrl: string;
  orgId: string | null;
  orgName: string | null;
}

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Infrawrench</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:90vh;background:#0b0e14;color:#e6e6e6">
<div style="text-align:center"><h2>Signed in to Infrawrench</h2><p>You can close this tab and return to VS Code.</p></div>`;

function secretStorage(secrets: vscode.SecretStorage): TokenStorage {
  return {
    get: async (key) => (await secrets.get(WORKOS_SECRET_PREFIX + key)) ?? null,
    set: (key, value) => Promise.resolve(secrets.store(WORKOS_SECRET_PREFIX + key, value)),
    delete: (key) => Promise.resolve(secrets.delete(WORKOS_SECRET_PREFIX + key)),
  };
}

export class Session implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private stored: StoredSession | null = null;
  private client: CloudFetch | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this.changed.dispose();
  }

  get orgId(): string | null {
    return this.stored?.orgId ?? null;
  }

  get orgName(): string | null {
    return this.stored?.orgName ?? null;
  }

  get mode(): AuthMode | null {
    return this.stored?.mode ?? null;
  }

  get cloudUrl(): string {
    return readConfig().cloudUrl;
  }

  /** The org-scoped client, or null when signed out or no org is chosen. */
  get api(): CloudFetch | null {
    return this.stored?.orgId ? this.client : null;
  }

  async restore(): Promise<void> {
    const stored = this.context.globalState.get<StoredSession>(STATE_KEY) ?? null;
    // A session belongs to the cloud it was made against.
    if (!stored || stored.cloudUrl !== this.cloudUrl) {
      await this.setState(null, null);
      return;
    }
    const source = await this.tokenSource(stored.mode);
    if (!source || !(await source.getAccessToken())) {
      await this.setState(null, null);
      return;
    }
    await this.setState(stored, source);
  }

  private async tokenSource(mode: AuthMode): Promise<AccessTokenSource | null> {
    if (mode === "apiKey") {
      const key = await this.context.secrets.get(API_KEY_SECRET);
      return key ? staticAccessToken(key) : null;
    }
    const cfg = readConfig();
    return new TokenManager({
      storage: secretStorage(this.context.secrets),
      clientId: cfg.workosClientId,
      workosApiUrl: cfg.workosApiUrl,
      onAuthError: (_code, message) => {
        void vscode.window.showWarningMessage(`Infrawrench: ${message}`);
        void this.signOut();
      },
    });
  }

  private async setState(
    stored: StoredSession | null,
    source: AccessTokenSource | null,
  ): Promise<void> {
    this.stored = stored;
    this.client = source ? createCloudFetch({ tokens: source, baseUrl: this.cloudUrl }) : null;
    await this.context.globalState.update(STATE_KEY, stored ?? undefined);
    await vscode.commands.executeCommand(
      "setContext",
      "infrawrench.signedIn",
      Boolean(stored?.orgId),
    );
    this.changed.fire();
  }

  async signIn(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(globe) Sign in with your browser",
          detail: "Use your Infrawrench account. Lists every organization you belong to.",
          mode: "browser" as const,
        },
        {
          label: "$(key) Use an API key",
          detail: "An iwk_ key from Settings > API keys. Scoped to one organization.",
          mode: "apiKey" as const,
        },
      ],
      { title: "Sign in to Infrawrench" },
    );
    if (!choice) return;
    if (choice.mode === "browser") await this.signInWithBrowser();
    else await this.signInWithApiKey();
  }

  private async signInWithBrowser(): Promise<void> {
    await this.clearSecrets();
    const manager = (await this.tokenSource("browser")) as TokenManager;
    const cfg = readConfig();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("base64url");
    const redirectUri = `http://127.0.0.1:${LOGIN_PORT}/callback`;
    const authorizeUrl = `${cfg.workosApiUrl}/user_management/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: cfg.workosClientId,
      redirect_uri: redirectUri,
      provider: "authkit",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString()}`;

    const email = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Infrawrench: waiting for the browser sign-in",
        cancellable: true,
      },
      (_progress, cancel) =>
        new Promise<string | null>((resolve, reject) => {
          const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", redirectUri);
            if (url.pathname !== "/callback") {
              res.writeHead(404).end();
              return;
            }
            const code = url.searchParams.get("code");
            const returned = url.searchParams.get("state") ?? "";
            if (
              !code ||
              returned.length !== state.length ||
              !crypto.timingSafeEqual(Buffer.from(returned), Buffer.from(state))
            ) {
              res
                .writeHead(400, { "Content-Type": "text/plain" })
                .end("Sign-in rejected (bad state).");
              return;
            }
            manager
              .exchangeAuthorizationCode(code, verifier)
              .then((result) => {
                res.writeHead(200, { "Content-Type": "text/html" }).end(CALLBACK_HTML);
                server.close();
                resolve(result.email);
              })
              .catch((err: unknown) => {
                res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed.");
                server.close();
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          });
          server.on("error", (err) =>
            reject(
              new Error(
                `Couldn't listen on 127.0.0.1:${LOGIN_PORT} (${err.message}). Is another Infrawrench sign-in (the CLI's, perhaps) in progress?`,
              ),
            ),
          );
          server.listen(LOGIN_PORT, "127.0.0.1", () => {
            void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl, true));
          });
          const timer = setTimeout(() => {
            server.close();
            reject(new Error("Sign-in timed out after 5 minutes."));
          }, LOGIN_TIMEOUT_MS);
          cancel.onCancellationRequested(() => {
            clearTimeout(timer);
            server.close();
            resolve(null);
          });
        }),
    );
    if (!email) return;
    const api = createCloudFetch({ tokens: manager, baseUrl: this.cloudUrl });
    const orgs = await fetchOrgs(api);
    if (orgs.length === 0) {
      void vscode.window.showWarningMessage(
        `Signed in as ${email}, but that account belongs to no organization yet.`,
      );
      return;
    }
    const org = orgs.length === 1 ? orgs[0]! : await pickOrg(orgs, this.stored?.orgId ?? null);
    if (!org) return;
    await this.setState(
      { mode: "browser", cloudUrl: this.cloudUrl, orgId: org.id, orgName: org.displayName },
      manager,
    );
    void vscode.window.showInformationMessage(
      `Infrawrench: signed in as ${email} (${org.displayName}).`,
    );
  }

  private async signInWithApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: "Infrawrench API key",
      prompt: "Create one under Settings > API keys. It is stored in VS Code's secret storage.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith("iwk_") ? null : "API keys start with iwk_"),
    });
    if (!key) return;
    const orgInput = await vscode.window.showInputBox({
      title: "Which organization is the key for?",
      prompt:
        "Paste any Infrawrench web address from inside the organization (for example the API keys page), or its id.",
      ignoreFocusOut: true,
      validateInput: (v) =>
        parseOrgIdInput(v) ? null : "Paste a URL containing /org/<id>/, or the id itself",
    });
    const orgId = orgInput ? parseOrgIdInput(orgInput) : null;
    if (!orgId) return;
    const source = staticAccessToken(key.trim());
    const api = createCloudFetch({ tokens: source, baseUrl: this.cloudUrl });
    try {
      await api.org(orgId, "/services");
    } catch (err) {
      const status = err instanceof CloudApiError ? err.status : 0;
      const reason =
        status === 401
          ? "the key was not accepted (revoked, expired, or for another organization)"
          : status === 403
            ? "the key lacks resources:read"
            : err instanceof Error
              ? err.message
              : String(err);
      void vscode.window.showErrorMessage(`Infrawrench: couldn't use that key: ${reason}.`);
      return;
    }
    await this.clearSecrets();
    await this.context.secrets.store(API_KEY_SECRET, key.trim());
    await this.setState({ mode: "apiKey", cloudUrl: this.cloudUrl, orgId, orgName: null }, source);
    void vscode.window.showInformationMessage("Infrawrench: signed in with an API key.");
  }

  async selectOrg(): Promise<void> {
    if (!this.stored || !this.client) {
      await this.signIn();
      return;
    }
    if (this.stored.mode === "apiKey") {
      const again = await vscode.window.showInformationMessage(
        "An API key belongs to one organization. Sign in again to use a different key.",
        "Sign In",
      );
      if (again) await this.signIn();
      return;
    }
    const org = await pickOrg(await fetchOrgs(this.client), this.stored.orgId);
    if (!org) return;
    await this.setState(
      { ...this.stored, orgId: org.id, orgName: org.displayName },
      await this.tokenSource("browser"),
    );
  }

  async signOut(): Promise<void> {
    await this.clearSecrets();
    await this.setState(null, null);
  }

  private async clearSecrets(): Promise<void> {
    await this.context.secrets.delete(API_KEY_SECRET);
    const manager = new TokenManager({
      storage: secretStorage(this.context.secrets),
      clientId: readConfig().workosClientId,
      workosApiUrl: readConfig().workosApiUrl,
    });
    await manager.clear();
  }
}

async function pickOrg(
  orgs: Array<{ id: string; displayName: string; role: string }>,
  currentId: string | null,
): Promise<{ id: string; displayName: string } | undefined> {
  const pick = await vscode.window.showQuickPick(
    orgs.map((o) => ({
      label: o.displayName,
      description: o.id === currentId ? "current" : o.role,
      org: o,
    })),
    { title: "Choose an Infrawrench organization" },
  );
  return pick?.org;
}
