import { useState, useEffect } from "react";
import type { Recipient } from "../api-types.js";
import { useSettingsHost } from "./host.js";
import { AlertRoutingSection } from "./AlertRoutingSection.js";
import { WeeklyDigestSection } from "./WeeklyDigestSection.js";
import { ExpiryAlertsSection } from "./ExpiryAlertsSection.js";
import { DriftAlertsSection } from "./notifications/DriftAlertsSection.js";
import { MsTeamsSection, TeamsMark } from "./notifications/MsTeamsSection.js";
import { PushPreferencesSection, PushRosterSection } from "./notifications/PushSections.js";
import { SlackSection, SlackMark } from "./notifications/SlackSection.js";
import { TwilioSection, type PagingSettings } from "./notifications/TwilioSection.js";

type ConnectionId = "slack" | "teams" | "mobile" | "sms";

const CONNECTIONS: Array<{
  id: ConnectionId;
  label: string;
  description: string;
}> = [
  {
    id: "slack",
    label: "Slack",
    description: "Workspace channels via OAuth",
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    description: "Channel webhooks",
  },
  {
    id: "mobile",
    label: "Mobile app",
    description: "Push to your devices",
  },
  {
    id: "sms",
    label: "SMS & voice",
    description: "Twilio paging",
  },
];

export function NotificationsSection() {
  const { orgId, api } = useSettingsHost();
  const [settings, setSettings] = useState<PagingSettings | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<ConnectionId>("slack");

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, r] = await Promise.all([
        api.get<PagingSettings>(`/api/org/${orgId}/twilio`),
        api.get<Recipient[]>(`/api/org/${orgId}/twilio/recipients`),
      ]);
      setSettings(s);
      setRecipients(r);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load paging settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (loadError) {
    return <p className="text-sm text-danger">{loadError}</p>;
  }
  if (loading || !settings) {
    return <p className="text-sm text-on-surface-faint">Loading…</p>;
  }

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-on-surface-muted mt-1 max-w-3xl">
          Alert your team when a resource type fails to sync repeatedly, a budget threshold is
          crossed, your infrastructure drifts, or a workflow calls <code>infra.page()</code> or{" "}
          <code>infra.waitForApproval()</code>. Incidents are triggered by the background poller;
          manual syncs from the UI never page. Delivery goes to mobile push (the Infrawrench app),
          any Slack or Microsoft Teams channels you connect below, and — when Twilio credentials are
          configured — SMS and voice calls.
        </p>
      </div>

      {/*
        Master–detail for delivery channels: the left rail is always the same four
        connection kinds; the right pane is only the setup for the selected one.
        Alert routing and the batch filters below need the full width, so they
        stay outside this split.
      */}
      <section className="border border-border rounded-xl overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Connections</h2>
          <p className="text-xs text-on-surface-muted mt-1">
            Add Slack, Teams, mobile push, or phone numbers — then route alerts to them with the
            rules below.
          </p>
        </div>
        <div className="flex min-h-[32rem] flex-col md:flex-row">
          <nav
            aria-label="Notification connections"
            className="w-full shrink-0 border-b border-border md:w-60 md:border-b-0 md:border-r md:overflow-y-auto"
          >
            <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-x-visible">
              {CONNECTIONS.map((c) => {
                const selected = selectedConnection === c.id;
                return (
                  <li key={c.id} className="min-w-[9.5rem] md:min-w-0">
                    <button
                      type="button"
                      onClick={() => setSelectedConnection(c.id)}
                      aria-current={selected ? "true" : undefined}
                      className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                        selected
                          ? "bg-surface-overlay text-on-surface-secondary"
                          : "text-on-surface-muted hover:bg-surface-overlay/60 hover:text-on-surface-secondary"
                      }`}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {c.id === "slack" && <SlackMark className="h-3.5 w-3.5 shrink-0" />}
                        {c.id === "teams" && <TeamsMark className="h-3.5 w-3.5 shrink-0" />}
                        {c.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-on-surface-tertiary">
                        {c.description}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 flex-1 p-5 md:overflow-y-auto">
            {/*
              Keep every pane mounted so in-progress forms (Twilio creds, Teams
              webhook paste, etc.) survive switching the left rail. Hidden panes
              stay out of the accessibility tree via `hidden`.
            */}
            <div hidden={selectedConnection !== "slack"}>
              <SlackSection orgId={orgId} embedded />
            </div>
            <div hidden={selectedConnection !== "teams"}>
              <MsTeamsSection orgId={orgId} embedded />
            </div>
            <div hidden={selectedConnection !== "mobile"} className="space-y-6">
              <PushPreferencesSection orgId={orgId} embedded />
              <PushRosterSection orgId={orgId} embedded />
            </div>
            <div hidden={selectedConnection !== "sms"}>
              <TwilioSection
                orgId={orgId}
                settings={settings}
                recipients={recipients}
                onChanged={() => void load()}
                embedded
              />
            </div>
          </div>
        </div>
      </section>

      <AlertRoutingSection orgId={orgId} />

      <div className="grid gap-6 lg:grid-cols-2">
        <DriftAlertsSection orgId={orgId} />
        <ExpiryAlertsSection />
        <div className="lg:col-span-2">
          <WeeklyDigestSection />
        </div>
      </div>
    </div>
  );
}
