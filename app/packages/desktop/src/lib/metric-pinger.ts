import { invoke } from "./invoke";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./sql-drivers";
import { METRIC_PINGS_CHANGED_EVENT } from "./metric-pings";

interface PingRow {
  id: string;
  resource_id: string;
  account_id: string;
  plugin_id: string;
  resource_type_id: string;
  resource_display_name: string;
  metric_label: string;
  min_value: number | null;
  max_value: number | null;
  last_alert_state: string | null;
}

const POLL_INTERVAL_MS = 60_000;

let started = false;
let runningTick = false;

export function startMetricPinger() {
  if (started) return;
  started = true;
  void syncActiveCount();
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  window.addEventListener(METRIC_PINGS_CHANGED_EVENT, () => {
    void syncActiveCount();
    void tick();
  });
}

async function syncActiveCount() {
  try {
    const db = await getDb();
    const rows = await db.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM metric_pings");
    const count = rows[0]?.c ?? 0;
    await invoke("set_pings_active", { count });
  } catch (err) {
    console.error("metric-pinger: syncActiveCount failed", err);
  }
}

async function tick() {
  if (runningTick) return;
  runningTick = true;
  try {
    const db = await getDb();
    const pings = await db.select<PingRow[]>("SELECT * FROM metric_pings");
    if (pings.length === 0) return;

    // Group by accountId so we decrypt credentials once per account
    const byAccount = new Map<string, PingRow[]>();
    for (const p of pings) {
      const list = byAccount.get(p.account_id) ?? [];
      list.push(p);
      byAccount.set(p.account_id, list);
    }

    await Promise.allSettled(
      [...byAccount.entries()].map(async ([accountId, accountPings]) => {
        let credentials: Record<string, string>;
        try {
          credentials = await invoke<Record<string, string>>("account_get_credentials", {
            accountId,
          });
        } catch {
          return;
        }

        // Group by pluginId+resourceTypeId+resourceId so we only fetch the
        // metric series once per resource. The user explicitly asked us not
        // to ping all metrics — we only check the metric_label that was set.
        const byResource = new Map<string, PingRow[]>();
        for (const p of accountPings) {
          const key = `${p.plugin_id}|${p.resource_type_id}|${p.resource_id}`;
          const list = byResource.get(key) ?? [];
          list.push(p);
          byResource.set(key, list);
        }

        await Promise.allSettled(
          [...byResource.entries()].map(async ([key, resourcePings]) => {
            const [pluginId, typeId, resourceId] = key.split("|");
            if (!pluginId || !typeId || !resourceId) return;
            const loaded = await getPlugin(pluginId);
            if (!loaded?.plugin.createClient) return;
            const services = buildPluginHostServices(loaded.plugin.manifest, credentials);
            const client = loaded.plugin.createClient(credentials, services);
            if (!client.fetchMetricSeries) return;
            const series = await client.fetchMetricSeries(typeId, resourceId, accountId);

            for (const ping of resourcePings) {
              const matched = series.find((s) => s.label === ping.metric_label);
              const latest = matched?.points.at(-1);
              if (!latest) continue;
              const state = evaluate(latest.value, ping.min_value, ping.max_value);
              if (state === "ok") {
                if (ping.last_alert_state && ping.last_alert_state !== "ok") {
                  await db.execute("UPDATE metric_pings SET last_alert_state = $1 WHERE id = $2", [
                    "ok",
                    ping.id,
                  ]);
                }
                continue;
              }
              // Out-of-range — only fire if the state changed (avoid spam every minute)
              if (ping.last_alert_state === state) continue;
              const unit = matched?.unit ? ` ${matched.unit}` : "";
              const range =
                ping.min_value !== null && ping.max_value !== null
                  ? `${ping.min_value}–${ping.max_value}`
                  : ping.min_value !== null
                    ? `≥ ${ping.min_value}`
                    : `≤ ${ping.max_value}`;
              const direction = state === "below" ? "below" : "above";
              await invoke("show_notification", {
                title: `${ping.resource_display_name}: ${ping.metric_label} ${direction} range`,
                body: `Latest ${latest.value}${unit} (allowed ${range}${unit})`,
              });
              await db.execute(
                "UPDATE metric_pings SET last_alert_state = $1, last_alert_at = datetime('now') WHERE id = $2",
                [state, ping.id],
              );
            }
          }),
        );
      }),
    );
  } catch (err) {
    console.error("metric-pinger: tick failed", err);
  } finally {
    runningTick = false;
  }
}

function evaluate(value: number, min: number | null, max: number | null): "ok" | "below" | "above" {
  if (min !== null && value < min) return "below";
  if (max !== null && value > max) return "above";
  return "ok";
}
