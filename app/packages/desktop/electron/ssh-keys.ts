/**
 * The user's own SSH keys, for the key pickers: private keys in `~/.ssh`,
 * and the external agents (Pageant, 1Password) offered beside them.
 */
import { dialog } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import { OpenSSHAgent, type ParsedKey } from "ssh2";
import { SshError } from "../shared/rpc/groups/ssh-common";
import type { AgentSshKey } from "../shared/rpc/groups/ssh-keys";
import { isPageantRunning } from "./pageant";
import { get1PasswordAgentPath, is1PasswordAgentRunning } from "./onepassword-agent";

const PRIVATE_KEY_HEADERS = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
];

const SKIP_FILES = new Set(["known_hosts", "known_hosts.old", "authorized_keys", "config"]);

// Without this gating, a compromised renderer could enumerate ~/.ssh/* by
// guessing filenames. Reads outside the allowlist fall through to a confirm dialog.
const SYSTEM_KEY_NAME_ALLOWLIST = new Set<string>();

function rememberSystemKeyName(name: string): void {
  SYSTEM_KEY_NAME_ALLOWLIST.add(name);
  SYSTEM_KEY_NAME_ALLOWLIST.add(`${name}.pub`);
}

function listSystemKeys(): { name: string }[] {
  const sshDir = path.join(os.homedir(), ".ssh");
  if (!fs.existsSync(sshDir)) return [];
  const results: { name: string }[] = [];
  for (const filename of fs.readdirSync(sshDir)) {
    if (filename.endsWith(".pub") || SKIP_FILES.has(filename)) continue;
    try {
      const filePath = path.join(sshDir, filename);
      if (!fs.statSync(filePath).isFile()) continue;
      const head = fs.readFileSync(filePath, "utf8").slice(0, 100);
      if (PRIVATE_KEY_HEADERS.some((h) => head.includes(h))) {
        results.push({ name: filename });
        rememberSystemKeyName(filename);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return results;
}

async function readSystemKey(name: string): Promise<string> {
  const base = path.basename(name);
  if (!SYSTEM_KEY_NAME_ALLOWLIST.has(base)) {
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "Confirm SSH key read",
      message: `Infrawrench wants to read ~/.ssh/${base}.`,
      detail:
        "This file was not in the last directory listing. Only allow this if you initiated the request.",
      buttons: ["Allow", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      throw new Error(`Read of ~/.ssh/${base} denied`);
    }
    rememberSystemKeyName(base.endsWith(".pub") ? base.slice(0, -4) : base);
  }
  const keyPath = path.join(os.homedir(), ".ssh", base);
  return fs.readFileSync(keyPath, "utf8");
}

const isParsedKey = (value: unknown): value is ParsedKey =>
  Predicate.hasProperty(value, "getPublicSSH") && Predicate.isFunction(value.getPublicSSH);

// ssh2 types `getIdentities` as `ParsedKey[]`, but older agents hand back a
// `PublicKeyEntry` wrapping the key in `pubKey`; accept either.
function toParsedKey(entry: unknown): ParsedKey | null {
  if (isParsedKey(entry)) return entry;
  if (Predicate.hasProperty(entry, "pubKey") && isParsedKey(entry.pubKey)) return entry.pubKey;
  return null;
}

// Lists the public keys 1Password currently holds, by speaking the OpenSSH
// agent protocol over its socket. Used by the create-resource SSH-key picker
// so the user can install a 1Password-managed pubkey on a new VM without
// having to copy it out of the 1Password app by hand.
function list1PasswordKeys(): Promise<AgentSshKey[]> {
  const sock = get1PasswordAgentPath();
  if (!sock) return Promise.resolve([]);
  return new Promise<AgentSshKey[]>((resolve) => {
    let settled = false;
    const finish = (keys: AgentSshKey[]) => {
      if (settled) return;
      settled = true;
      resolve(keys);
    };
    try {
      const agent = new OpenSSHAgent(sock);
      // Hedge against an unresponsive agent so the picker isn't blocked.
      const timer = setTimeout(() => {
        console.warn("[1password-agent] getIdentities timed out");
        finish([]);
      }, 2_000);
      agent.getIdentities((err, identities) => {
        clearTimeout(timer);
        if (err || !identities) {
          if (err) console.warn(`[1password-agent] getIdentities failed: ${err.message}`);
          finish([]);
          return;
        }
        const out: AgentSshKey[] = [];
        identities.forEach((entry, i) => {
          const parsed = toParsedKey(entry);
          if (!parsed) return;
          const b64 = parsed.getPublicSSH().toString("base64");
          const comment = parsed.comment ?? "";
          const openssh = `${parsed.type} ${b64}${comment ? ` ${comment}` : ""}`;
          const name = (comment.trim() || `1password-${i + 1}`).slice(0, 64);
          out.push({ name, publicKey: openssh, keyType: parsed.type });
        });
        finish(out);
      });
    } catch (e) {
      console.warn(
        `[1password-agent] OpenSSHAgent threw: ${Predicate.isError(e) ? e.message : String(e)}`,
      );
      finish([]);
    }
  });
}

/** The key pickers' sources, as the RPC handlers call them. */
export class SshKeys extends Context.Service<
  SshKeys,
  {
    readonly listSystemKeys: Effect.Effect<{ name: string }[]>;
    readonly readSystemKey: (name: string) => Effect.Effect<string, SshError>;
    readonly pageantRunning: Effect.Effect<boolean>;
    readonly onePasswordRunning: Effect.Effect<boolean>;
    readonly onePasswordKeys: Effect.Effect<AgentSshKey[]>;
  }
>()("infrawrench/desktop/SshKeys") {
  static readonly layer = Layer.succeed(SshKeys)(
    SshKeys.of({
      listSystemKeys: Effect.sync(listSystemKeys),
      readSystemKey: (name) =>
        Effect.tryPromise({
          try: () => readSystemKey(name),
          catch: (cause) =>
            new SshError({ message: Predicate.isError(cause) ? cause.message : String(cause) }),
        }),
      pageantRunning: Effect.promise(isPageantRunning),
      onePasswordRunning: Effect.sync(is1PasswordAgentRunning),
      onePasswordKeys: Effect.promise(list1PasswordKeys),
    }),
  );
}
