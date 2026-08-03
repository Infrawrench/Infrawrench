import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  SshFanoutView,
  useUIStore,
  type SshFanoutRunOutcome,
  type SshFanoutRunRequest,
  type SshFanoutSnippetInfo,
  type SshFanoutTargetInfo,
} from "@infrawrench/ui";
import {
  runWithConcurrency,
  FANOUT_DEFAULT_CONCURRENCY,
  type FanoutHostResult,
} from "@infrawrench/client-core";
import { invoke } from "@/lib/invoke";
import { getDb } from "@/db/client";
import { createPluginClient } from "@/lib/plugin-client";
import { sshExecCommand } from "@/lib/ssh-tunnel";
import {
  createCloudFanoutSnippet,
  deleteCloudFanoutSnippet,
  listCloudFanoutSnippets,
  listCloudFanoutTargets,
  runCloudFanout,
} from "@/lib/cloud-ssh-fanout";

export const Route = createFileRoute("/ssh-fanout")({
  component: SshFanoutPage,
});

/**
 * Fan-out SSH on desktop — the same shared `SshFanoutView` web renders.
 *
 * Cloud mode mirrors web exactly over the `cloud_ssh_fanout_*` IPC bridge
 * (server-side exec, freeze gate, audit, org-shared snippets). Local-only mode
 * fans out over the machine's own SSH accounts through the existing
 * `ssh_exec_command` IPC (host-key prompts and 1Password/Pageant sentinels
 * included), with client-side concurrency. Local mode has no org, so snippets
 * (an org-shared server-side store) are cloud-only.
 */
function SshFanoutPage() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  return activeCloudOrgId ? (
    <CloudFanout key={activeCloudOrgId} orgId={activeCloudOrgId} />
  ) : (
    <LocalFanout />
  );
}

function CloudFanout({ orgId }: { orgId: string }) {
  const [targets, setTargets] = useState<SshFanoutTargetInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [sshKeys, setSshKeys] = useState<Array<{ id: string; name: string }>>([]);
  const [snippets, setSnippets] = useState<SshFanoutSnippetInfo[]>([]);

  async function loadSnippets(isStale?: () => boolean) {
    try {
      const rows = await listCloudFanoutSnippets(orgId);
      if (!isStale?.()) setSnippets(rows);
    } catch {
      /* snippets are a convenience */
    }
  }

  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    setTargetsError(null);
    listCloudFanoutTargets(orgId)
      .then((t) => {
        if (!cancelled) setTargets(t);
      })
      .catch((e) => {
        if (!cancelled) setTargetsError(e instanceof Error ? e.message : "Failed to load hosts");
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false);
      });
    invoke<Array<{ id: string; name: string }>>("cloud_ssh_keys_list", { orgId })
      .then((keys) => {
        if (!cancelled) setSshKeys(keys.map((k) => ({ id: k.id, name: k.name })));
      })
      .catch(() => {
        /* keys only matter for quick-connect targets */
      });
    // Participates in the same cancellation flow: a response that lands after
    // orgId changed must not apply another org's snippets.
    void loadSnippets(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function onRun(input: SshFanoutRunRequest): Promise<SshFanoutRunOutcome> {
    return runCloudFanout(
      orgId,
      {
        command: input.command,
        targets: input.targets.map((t) => ({ kind: t.kind, id: t.id })),
        sshKeyId: input.sshKeyId,
        username: input.username,
      },
      input.overrideFreeze === true,
    );
  }

  return (
    <SshFanoutView
      targets={targets}
      targetsLoading={targetsLoading}
      targetsError={targetsError}
      sshKeys={sshKeys}
      snippets={snippets}
      onRun={onRun}
      onSaveSnippet={async ({ name, command }) => {
        await createCloudFanoutSnippet(orgId, { name, command });
        await loadSnippets();
      }}
      onDeleteSnippet={async (id) => {
        await deleteCloudFanoutSnippet(orgId, id);
        await loadSnippets();
      }}
    />
  );
}

function LocalFanout() {
  const [targets, setTargets] = useState<SshFanoutTargetInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<Array<{ id: string; display_name: string }>>(
          "SELECT id, display_name FROM accounts WHERE plugin_id = 'ssh' ORDER BY display_name",
        );
        if (cancelled) return;
        setTargets(
          rows.map((r) => ({
            kind: "account" as const,
            id: r.id,
            label: r.display_name,
            pluginId: "ssh",
            running: true,
            needsKey: false,
            tags: [],
          })),
        );
      } catch (e) {
        if (!cancelled) setTargetsError(e instanceof Error ? e.message : "Failed to load hosts");
      } finally {
        if (!cancelled) setTargetsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onRun = useMemo(
    () =>
      async (input: SshFanoutRunRequest): Promise<SshFanoutRunOutcome> => {
        const results = await runWithConcurrency(
          input.targets,
          FANOUT_DEFAULT_CONCURRENCY,
          async (target): Promise<FanoutHostResult> => {
            const started = Date.now();
            try {
              const client = await createPluginClient(target.id, "ssh");
              const config = client.getSshConfig?.();
              if (!config) throw new Error("Account has no SSH configuration");
              const res = await sshExecCommand(
                {
                  sshHost: config.host,
                  sshPort: config.port,
                  sshUser: config.username,
                  privateKey: config.privateKey,
                },
                input.command,
              );
              return {
                targetId: target.id,
                label: target.label,
                status: "done",
                exitCode: res.code,
                stdout: res.stdout,
                stderr: res.stderr,
                durationMs: Date.now() - started,
              };
            } catch (e) {
              return {
                targetId: target.id,
                label: target.label,
                status: "error",
                exitCode: null,
                stdout: "",
                stderr: "",
                error: e instanceof Error ? e.message : "SSH exec failed",
                durationMs: Date.now() - started,
              };
            }
          },
        );
        return { kind: "results", results };
      },
    [],
  );

  return (
    <SshFanoutView
      targets={targets}
      targetsLoading={targetsLoading}
      targetsError={targetsError}
      sshKeys={[]}
      snippets={[]}
      onRun={onRun}
    />
  );
}
