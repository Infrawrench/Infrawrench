/**
 * The SSH host's own rules: which command strings name a repository, what a
 * command does when the key or the repository is no longer what it was,
 * what failures are counted against, and what reaches the log.
 */
import type { ExecChannel } from "@infrawrench/git-ssh";
import { describe, expect, it } from "vitest";
import type { RepoAccess } from "../../auth/access";
import type { OfferedSshKey } from "../../auth/authenticate";
import type { Principal } from "../../auth/principal";
import type { Env } from "../../env";
import type { GitDirectory } from "../directory";
import { parseCommand } from "../ssh/command";
import { type Session, gitExec, logField } from "../ssh/host";
import { rateLimitKey } from "../ssh/rate-limit";

describe("the SSH command, as a table", () => {
  const accepted: ReadonlyArray<readonly [string, string, string]> = [
    ["git-upload-pack 'alice/demo.git'", "alice", "demo"],
    ["git-upload-pack '/alice/demo.git'", "alice", "demo"],
    ["git-receive-pack 'alice/demo'", "alice", "demo"],
    ["git upload-pack 'alice/demo.git'", "alice", "demo"],
    ["git-upload-pack alice/demo.git", "alice", "demo"],
    // The suffix comes off once, in any case; what is left is looked up as it is.
    ["git-upload-pack 'alice/demo.GIT'", "alice", "demo"],
    ["git-upload-pack 'alice/demo.git.git'", "alice", "demo.git"],
    ["git-upload-pack 'Alice/Demo'", "Alice", "Demo"],
    ["git-upload-pack   'alice/demo'  ", "alice", "demo"],
  ];

  it.each(accepted)("takes %s", (command, owner, name) => {
    expect(parseCommand(command)).toMatchObject({ kind: "git", owner, name });
  });

  const refused: ReadonlyArray<readonly [string, string]> = [
    // Traversal and odd segments.
    ["git-upload-pack 'alice/../demo'", "parent segment"],
    ["git-upload-pack '../alice/demo'", "leading parent segment"],
    ["git-upload-pack 'alice/..'", "parent as the name"],
    ["git-upload-pack './alice/demo'", "dot segment"],
    ["git-upload-pack 'alice/./demo'", "inner dot segment"],
    ["git-upload-pack 'alice//demo'", "empty segment"],
    ["git-upload-pack '//alice/demo'", "two leading slashes"],
    ["git-upload-pack 'alice/demo/'", "trailing slash"],
    ["git-upload-pack 'alice/demo/extra'", "three segments"],
    ["git-upload-pack 'demo'", "one segment"],
    ["git-upload-pack ''", "empty path"],
    ["git-upload-pack 'alice/.git'", "only the suffix"],
    ["git-upload-pack 'alice/.demo'", "a leading dot"],
    // Home directories and absolute paths elsewhere.
    ["git-upload-pack '~alice/demo'", "home directory"],
    ["git-upload-pack '~/demo'", "own home directory"],
    ["git-upload-pack '/~alice/demo'", "home directory after a slash"],
    ["git-upload-pack '/srv/git/alice/demo'", "an absolute server path"],
    // Characters no name has.
    ["git-upload-pack 'alice\\demo'", "backslash"],
    ["git-upload-pack 'alice/de\u0000mo'", "NUL"],
    ["git-upload-pack 'alice/de\nmo'", "newline"],
    ["git-upload-pack 'alice/de\u001bmo'", "escape"],
    ["git-upload-pack 'alice/demo;id'", "semicolon"],
    ["git-upload-pack 'alice/$(id)'", "command substitution"],
    ["git-upload-pack 'alice/`id`'", "backticks"],
    ["git-upload-pack 'alice/demo|cat'", "pipe"],
    ["git-upload-pack 'alice/demo&'", "ampersand"],
    ["git-upload-pack 'alice/demo>x'", "redirect"],
    ["git-upload-pack 'alice/de mo'", "space"],
    ["git-upload-pack 'alice/%2e%2e'", "percent-encoded dots, not decoded"],
    ["git-upload-pack 'alice/demo%2fx'", "percent-encoded slash, not decoded"],
    // Anything outside ASCII, before any lookup.
    ["git-upload-pack 'alic\u0435/demo'", "Cyrillic confusable"],
    ["git-upload-pack 'alice/\uff44emo'", "full-width letter"],
    ["git-upload-pack 'alice/de\u0301mo'", "combining mark"],
    ["git-upload-pack 'alice/\u202edemo'", "right-to-left override"],
    ["git-upload-pack 'alice/demo\u200b'", "zero-width space"],
    ["git-upload-pack 'alice/demo'\u3000", "ideographic space after the path"],
    ["git-upload-pack 'alice/demo'\u00a0", "no-break space after the path"],
    // Options and extra arguments.
    ["git-upload-pack --upload-pack=touch 'alice/demo'", "an option first"],
    ["git-upload-pack '--help/demo'", "an option-like path"],
    ["git-upload-pack --x/demo", "an option-like bare path"],
    ["git-upload-pack 'alice/demo' --strict", "an argument after"],
    ["git-upload-pack 'alice/demo' 'other/repo'", "two paths"],
    ["git-upload-pack 'alice/demo'\n'other/repo'", "a second line"],
    // Quoting git never writes.
    ['git-upload-pack "alice/demo"', "double quotes"],
    ["git-upload-pack 'alice/demo", "unterminated quote"],
    ["git-upload-pack 'alice'\\x'/demo'", "an escape that is not a quote"],
    // Other commands.
    ["git-upload-archive 'alice/demo'", "upload-archive"],
    ["git upload-archive 'alice/demo'", "upload-archive, spaced"],
    ["git-upload-pack", "no path"],
    ["git-upload-packx 'alice/demo'", "a longer verb"],
    ["GIT-UPLOAD-PACK 'alice/demo'", "upper case verb"],
    [" git-upload-pack 'alice/demo'", "a leading space"],
    ["sh -c 'git-upload-pack alice/demo'", "a shell"],
    ["scp -t alice/demo", "scp"],
    ["git-lfs-authenticate 'alice/demo' download", "LFS"],
    ["", "nothing"],
    [`git-upload-pack '${"a".repeat(101)}/demo'`, "a namespace over 100 characters"],
    [`git-upload-pack 'alice/${"x".repeat(4000)}'`, "very long"],
  ];

  it.each(refused)("refuses %j (%s)", (command) => {
    expect(parseCommand(command).kind).toBe("unsupported");
  });
});

describe("running a command", () => {
  const key: OfferedSshKey = {
    algorithm: "ssh-ed25519",
    blob: new Uint8Array([1, 2, 3]),
    fingerprint: "SHA256:placeholder",
  };
  const person: Principal = {
    kind: "user",
    userId: "u-1",
    via: "ssh-key",
    scopes: null,
    credentialId: "k-1",
  };
  const deployKey: Principal = {
    kind: "deploy-key",
    keyId: "d-1",
    repositoryId: "repo-1",
    readOnly: true,
  };

  /** Repositories by `owner/name`, with the access each principal kind gets. */
  const directory = (
    current: Principal | null,
    repos: Record<string, { id: string; access: (who: Principal) => RepoAccess }>,
  ): GitDirectory & { lookups: string[] } => {
    const lookups: string[] = [];
    return {
      lookups,
      authenticate: async () => {
        throw new Error("not used over SSH");
      },
      authenticateArchiveToken: async () => null,
      authenticateKey: async () => current,
      describe: async () => "there",
      resolveRepository: async (owner, name, principal) => {
        lookups.push(`${owner}/${name}`);
        const found = repos[`${owner}/${name}`];
        if (!found) return null;
        return {
          id: found.id,
          owner,
          name,
          archived: false,
          access: found.access(principal),
          pushPolicy: async () => ({ rules: [], userId: null, admin: false }),
        };
      },
    };
  };

  const channel = (): ExecChannel & { errors: () => string } => {
    const chunks: Uint8Array[] = [];
    return {
      stdin: new ReadableStream({ start: (controller) => controller.close() }),
      stdout: new WritableStream(),
      stderr: new WritableStream({ write: (chunk) => void chunks.push(chunk) }),
      signal: new AbortController().signal,
      errors: () => new TextDecoder().decode(Buffer.concat(chunks)),
    };
  };

  // None of the commands below reaches the Durable Object.
  const env = {} as Pick<Env, "REPO">;
  const run = async (dir: GitDirectory, session: Session, command: string) => {
    const io = channel();
    const status = await gitExec(env, dir)(session, command, io, new Map());
    return { status, stderr: io.errors() };
  };

  it("runs nothing for a key removed since the connection opened", async () => {
    const dir = directory(null, { "alice/demo": { id: "repo-1", access: () => "admin" } });
    const result = await run(
      dir,
      { principal: person, name: "alice", key },
      "git-upload-pack 'alice/demo'",
    );
    expect(result).toEqual({ status: 1, stderr: "ERROR: This key is no longer accepted.\n" });
    expect(dir.lookups).toEqual([]);
  });

  it("uses what the key resolves to now, not what it did at login", async () => {
    // At login the key was a person's; it has since become nobody's but a deploy key's.
    const dir = directory(deployKey, {
      "alice/demo": {
        id: "repo-2",
        access: (who) => (who.kind === "user" ? "admin" : "none"),
      },
    });
    const result = await run(
      dir,
      { principal: person, name: "alice", key },
      "git-upload-pack 'alice/demo'",
    );
    expect(result).toEqual({ status: 1, stderr: "ERROR: Repository not found.\n" });
  });

  it("answers a missing and an unreadable repository with the same words", async () => {
    const dir = directory(person, { "alice/secret": { id: "repo-3", access: () => "none" } });
    const session = { principal: person, name: "alice", key };
    const missing = await run(dir, session, "git-upload-pack 'alice/nothing'");
    const hidden = await run(dir, session, "git-upload-pack 'alice/secret'");
    expect(hidden).toEqual(missing);
    const pushMissing = await run(dir, session, "git-receive-pack 'alice/nothing'");
    const pushHidden = await run(dir, session, "git-receive-pack 'alice/secret'");
    expect(pushHidden).toEqual(pushMissing);
  });

  it("lets a read-only deploy key fetch its repository but not push to it", async () => {
    const dir = directory(deployKey, {
      "alice/demo": {
        id: "repo-1",
        access: (who) =>
          who.kind === "deploy-key" && who.repositoryId === "repo-1" ? "read" : "none",
      },
      "alice/other": { id: "repo-9", access: () => "none" },
    });
    const session = { principal: deployKey, name: "alice/demo", key };
    const push = await run(dir, session, "git-receive-pack 'alice/demo'");
    expect(push.status).toBe(1);
    expect(push.stderr).toMatch(/permission to push/);
    const elsewhere = await run(dir, session, "git-upload-pack 'alice/other'");
    expect(elsewhere).toEqual({ status: 1, stderr: "ERROR: Repository not found.\n" });
  });

  it("refuses a command it does not serve before looking anything up", async () => {
    const dir = directory(person, {});
    const result = await run(
      dir,
      { principal: person, name: "alice", key },
      "git-upload-archive 'alice/demo'",
    );
    expect(result.status).toBe(1);
    expect(dir.lookups).toEqual([]);
  });
});

describe("what failed authentication is counted against", () => {
  it("is an IPv4 address as it is", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("is the /64 of an IPv6 address, however it is written", () => {
    const key = "2001:db8:aa:bb::/64";
    for (const address of [
      "2001:db8:aa:bb::1",
      "2001:db8:aa:bb:ffff:ffff:ffff:ffff",
      "2001:0DB8:00aa:00bb:0:0:0:2",
      "2001:db8:aa:bb:1:2:3.4.5.6",
      "2001:db8:aa:bb::1%eth0",
    ]) {
      expect(rateLimitKey(address), address).toBe(key);
    }
    expect(rateLimitKey("2001:db8:aa:bc::1")).not.toBe(key);
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("is the IPv4 address inside an IPv4-mapped IPv6 address", () => {
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("is the text itself when it does not parse", () => {
    expect(rateLimitKey("not:an:address::x")).toBe("not:an:address::x");
    expect(rateLimitKey("1::2::3")).toBe("1::2::3");
  });
});

describe("the connection log line", () => {
  it("quotes a client's text, keeps it printable and cuts it short", () => {
    expect(logField("SSH-2.0-OpenSSH_9.6 Ubuntu-3")).toBe('"SSH-2.0-OpenSSH_9.6 Ubuntu-3"');
    expect(logField('x" auth=true')).toBe('"x\\" auth=true"');
    expect(logField("a\nb\u0000c")).toBe('"a?b?c"');
    const long = logField("x".repeat(500));
    expect(long.length).toBeLessThan(100);
  });
});
