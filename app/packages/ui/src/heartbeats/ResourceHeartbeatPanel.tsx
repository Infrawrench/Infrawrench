import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  heartbeatScheduleOf,
  type Heartbeat,
  type HeartbeatSuggestion,
} from "@infrawrench/client-core";
import { HeartbeatEditorModal } from "./HeartbeatEditorModal.js";
import { PingInstructions } from "./PingInstructions.js";
import { formatWhen, scheduleLabel, statusLabel } from "./format.js";
import type { HeartbeatsClient } from "./types.js";

export interface ResourceHeartbeatPanelProps {
  client: HeartbeatsClient;
  resourceId: string;
  resourceName: string;
  /** Open the org's Heartbeats tab. */
  onOpenHeartbeats?: (() => void) | undefined;
}

/**
 * The resource detail's Heartbeat tab, offered on any resource whose plugin
 * flags the field holding its schedule. Shows the heartbeats already watching
 * this job, and "Watch with a heartbeat", which opens the editor with the
 * schedule read from the resource.
 */
export function ResourceHeartbeatPanel({
  client,
  resourceId,
  resourceName,
  onOpenHeartbeats,
}: ResourceHeartbeatPanelProps) {
  const gt = useGT();
  const [watching, setWatching] = useState<Heartbeat[] | null>(null);
  const [suggestion, setSuggestion] = useState<HeartbeatSuggestion | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    Promise.all([client.listHeartbeats(), client.listSuggestions(resourceId)])
      .then(([all, suggestions]) => {
        setWatching(all.filter((h) => h.resourceId === resourceId));
        setSuggestion(suggestions[0] ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : gt("Failed to load heartbeats")));
  }, [client, resourceId, gt]);

  useEffect(() => {
    reload();
  }, [reload]);

  const canCreate = Boolean(client.createHeartbeat);

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}
      {watching === null && !error && (
        <p className="text-sm text-on-surface-faint">{gt("Loading heartbeats…")}</p>
      )}
      {suggestion && (
        <p className="text-xs text-on-surface-secondary">
          {gt("Schedule: {schedule}", {
            schedule: suggestion.schedule
              ? scheduleLabel(suggestion.schedule, gt)
              : suggestion.rawSchedule,
          })}
        </p>
      )}
      {watching !== null && watching.length === 0 && (
        <p className="text-sm text-on-surface-faint">{gt("No heartbeat watches this job.")}</p>
      )}
      {watching?.map((heartbeat) => {
        const schedule = heartbeatScheduleOf(heartbeat);
        return (
          <div
            key={heartbeat.id}
            className="space-y-3 rounded-xl border border-border bg-surface-raised px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-on-surface">{heartbeat.name}</span>
              <span className="text-xs text-on-surface-secondary">
                {statusLabel(heartbeat, gt)}
              </span>
            </div>
            <p className="text-xs text-on-surface-secondary">
              {schedule ? scheduleLabel(schedule, gt) : ""}
              {heartbeat.lastPingAt
                ? gt(" · last ping {when}", { when: formatWhen(heartbeat.lastPingAt) })
                : gt(" · never pinged")}
            </p>
            <PingInstructions pingUrl={heartbeat.pingUrl} />
          </div>
        );
      })}
      <div className="flex gap-2">
        {canCreate && suggestion && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 rounded-lg text-sm bg-accent hover:bg-accent-hover text-on-accent transition-colors"
          >
            {gt("Watch with a heartbeat")}
          </button>
        )}
        {onOpenHeartbeats && (
          <button
            type="button"
            onClick={onOpenHeartbeats}
            className="px-3 py-1.5 rounded-lg text-sm border border-border text-on-surface hover:border-border-strong transition-colors"
          >
            {gt("All heartbeats")}
          </button>
        )}
      </div>
      {creating && suggestion && (
        <HeartbeatEditorModal
          client={client}
          existing={null}
          seed={{ name: resourceName, suggestion }}
          onSaved={() => reload()}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
