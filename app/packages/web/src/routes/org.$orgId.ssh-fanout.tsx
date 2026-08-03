import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  SshFanoutView,
  type SshFanoutRunOutcome,
  type SshFanoutRunRequest,
  type SshFanoutSnippetInfo,
  type SshFanoutTargetInfo,
} from "@infrawrench/ui";
import type { FanoutHostResult } from "@infrawrench/client-core";
import { apiFetch, apiGet, apiPost, apiDelete, ChangeFreezeBlockedClientError } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/ssh-fanout")({
  component: SshFanoutPage,
});

interface TargetsResponse {
  targets: SshFanoutTargetInfo[];
}
interface SnippetsResponse {
  snippets: SshFanoutSnippetInfo[];
}
interface RunResponse {
  results: Array<FanoutHostResult & { hostKeyTrust?: unknown }>;
}
interface SshKeyRow {
  id: string;
  name: string;
}

/**
 * Fan-out SSH page. The whole surface lives in `@infrawrench/ui`
 * (`SshFanoutView`) so desktop renders the identical screen; this route wires
 * it to the org HTTP API and maps the change-freeze 423 into the shared
 * component's freeze outcome.
 */
function SshFanoutPage() {
  const { orgId } = Route.useParams();
  const [targets, setTargets] = useState<SshFanoutTargetInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [sshKeys, setSshKeys] = useState<SshKeyRow[]>([]);
  const [snippets, setSnippets] = useState<SshFanoutSnippetInfo[]>([]);

  async function loadSnippets() {
    try {
      const res = await apiGet<SnippetsResponse>(`/api/org/${orgId}/ssh-fanout/snippets`);
      setSnippets(res.snippets);
    } catch {
      // Snippets are a convenience — the page still works without them.
    }
  }

  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    setTargetsError(null);
    apiGet<TargetsResponse>(`/api/org/${orgId}/ssh-fanout/targets`)
      .then((res) => {
        if (!cancelled) setTargets(res.targets);
      })
      .catch((e) => {
        if (!cancelled) setTargetsError(e instanceof Error ? e.message : "Failed to load hosts");
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false);
      });
    apiGet<SshKeyRow[]>(`/api/org/${orgId}/ssh-keys`)
      .then((keys) => {
        if (!cancelled) setSshKeys(keys.map((k) => ({ id: k.id, name: k.name })));
      })
      .catch(() => {
        /* keys only matter for quick-connect targets */
      });
    void loadSnippets();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function onRun(input: SshFanoutRunRequest): Promise<SshFanoutRunOutcome> {
    try {
      const res = await apiFetch<RunResponse>(`/api/org/${orgId}/ssh-fanout/run`, {
        method: "POST",
        body: JSON.stringify({
          command: input.command,
          targets: input.targets.map((t) => ({ kind: t.kind, id: t.id })),
          ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
          ...(input.username ? { username: input.username } : {}),
        }),
        headers: {
          "Content-Type": "application/json",
          ...(input.overrideFreeze ? { "x-change-freeze-override": "true" } : {}),
        },
      });
      return { kind: "results", results: res.results };
    } catch (e) {
      if (e instanceof ChangeFreezeBlockedClientError) {
        return { kind: "freeze", message: e.message };
      }
      throw e;
    }
  }

  return (
    <SshFanoutView
      key={orgId}
      targets={targets}
      targetsLoading={targetsLoading}
      targetsError={targetsError}
      sshKeys={sshKeys}
      snippets={snippets}
      onRun={onRun}
      onSaveSnippet={async ({ name, command }) => {
        await apiPost(`/api/org/${orgId}/ssh-fanout/snippets`, { name, command });
        await loadSnippets();
      }}
      onDeleteSnippet={async (id) => {
        await apiDelete(`/api/org/${orgId}/ssh-fanout/snippets/${id}`);
        await loadSnippets();
      }}
    />
  );
}
