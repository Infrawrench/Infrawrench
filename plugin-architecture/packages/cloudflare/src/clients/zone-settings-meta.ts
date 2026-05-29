import type { SettingDescriptor } from "@infrawrench/plugin-base";

/**
 * Curated presentation metadata for common Cloudflare zone settings. Anything
 * not listed falls back to an inferred control + humanized label, so new
 * settings still render usefully without a code change.
 */
interface SettingMeta {
  label: string;
  control: SettingDescriptor["control"];
  options?: { value: string; label: string }[];
  group?: string;
  description?: string;
}

const onOff = (label: string, group: string, description?: string): SettingMeta => ({
  label,
  control: "toggle",
  group,
  ...(description ? { description } : {}),
});

const SETTING_META: Record<string, SettingMeta> = {
  // SSL/TLS
  ssl: {
    label: "SSL/TLS encryption mode",
    control: "select",
    group: "SSL/TLS",
    options: [
      { value: "off", label: "Off" },
      { value: "flexible", label: "Flexible" },
      { value: "full", label: "Full" },
      { value: "strict", label: "Full (strict)" },
    ],
  },
  min_tls_version: {
    label: "Minimum TLS version",
    control: "select",
    group: "SSL/TLS",
    options: ["1.0", "1.1", "1.2", "1.3"].map((v) => ({ value: v, label: `TLS ${v}` })),
  },
  always_use_https: onOff("Always Use HTTPS", "SSL/TLS"),
  automatic_https_rewrites: onOff("Automatic HTTPS Rewrites", "SSL/TLS"),
  opportunistic_encryption: onOff("Opportunistic Encryption", "SSL/TLS"),
  tls_1_3: onOff("TLS 1.3", "SSL/TLS"),
  // Security
  security_level: {
    label: "Security level",
    control: "select",
    group: "Security",
    options: [
      { value: "off", label: "Off" },
      { value: "essentially_off", label: "Essentially Off" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "under_attack", label: "I'm Under Attack" },
    ],
  },
  challenge_ttl: { label: "Challenge passage (seconds)", control: "number", group: "Security" },
  browser_check: onOff("Browser Integrity Check", "Security"),
  email_obfuscation: onOff("Email Address Obfuscation", "Security"),
  hotlink_protection: onOff("Hotlink Protection", "Security"),
  // Performance
  brotli: onOff("Brotli compression", "Performance"),
  http2: onOff("HTTP/2", "Performance"),
  http3: onOff("HTTP/3 (QUIC)", "Performance"),
  "0rtt": onOff("0-RTT Connection Resumption", "Performance"),
  early_hints: onOff("Early Hints", "Performance"),
  rocket_loader: onOff("Rocket Loader", "Performance"),
  // Caching
  cache_level: {
    label: "Caching level",
    control: "select",
    group: "Caching",
    options: [
      { value: "bypass", label: "No query string" },
      { value: "basic", label: "Standard" },
      { value: "aggressive", label: "Ignore query string" },
    ],
  },
  browser_cache_ttl: { label: "Browser Cache TTL (seconds)", control: "number", group: "Caching" },
  development_mode: onOff("Development Mode", "Caching"),
  always_online: onOff("Always Online", "Caching"),
  // Network
  ipv6: onOff("IPv6 Compatibility", "Network"),
  websockets: onOff("WebSockets", "Network"),
  ip_geolocation: onOff("IP Geolocation", "Network"),
};

const ACRONYMS = new Set([
  "https",
  "http",
  "ssl",
  "tls",
  "ip",
  "ipv6",
  "ttl",
  "ddos",
  "waf",
  "hsts",
  "nel",
  "rtt",
  "url",
  "cname",
  "dns",
]);

/** Turn a raw setting id ("always_use_https") into a label ("Always Use Https"). */
function humanize(id: string): string {
  if (id === "0rtt") return "0-RTT Connection Resumption";
  return id
    .split(/[_\s]+/)
    .map((w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

function inferControl(value: unknown): SettingDescriptor["control"] {
  if (value === "on" || value === "off") return "toggle";
  if (typeof value === "number") return "number";
  return "text";
}

interface RawZoneSetting {
  id?: unknown;
  value?: unknown;
  editable?: unknown;
}

/** Build the host-facing setting form rows from Cloudflare's /settings array. */
export function buildZoneSettingDescriptors(raw: RawZoneSetting[]): SettingDescriptor[] {
  const descriptors = raw
    .filter((s): s is RawZoneSetting & { id: string } => typeof s["id"] === "string")
    .map((s) => {
      const id = s.id;
      const editable = s.editable !== false;
      const valueStr =
        s.value !== null && typeof s.value === "object"
          ? JSON.stringify(s.value)
          : String(s.value ?? "");
      const meta = SETTING_META[id];
      let control: SettingDescriptor["control"];
      if (!editable) control = "readonly";
      else if (meta) control = meta.control;
      else control = inferControl(s.value);

      const descriptor: SettingDescriptor = {
        id,
        label: meta?.label ?? humanize(id),
        control,
        value: valueStr,
      };
      if (control === "select" && meta?.options) descriptor.options = meta.options;
      if (meta?.group) descriptor.group = meta.group;
      if (meta?.description) descriptor.description = meta.description;
      return descriptor;
    });

  // Group order: curated groups first (in a stable order), then ungrouped.
  const groupOrder = ["SSL/TLS", "Security", "Performance", "Caching", "Network", ""];
  return descriptors.sort((a, b) => {
    const ga = groupOrder.indexOf(a.group ?? "");
    const gb = groupOrder.indexOf(b.group ?? "");
    if (ga !== gb)
      return (ga === -1 ? groupOrder.length : ga) - (gb === -1 ? groupOrder.length : gb);
    return a.label.localeCompare(b.label);
  });
}

/**
 * Coerce a UI string value back to the type Cloudflare's per-setting edit
 * expects. Toggles/enums stay strings; curated number settings and bare
 * integers become numbers; JSON blobs are parsed.
 */
export function coerceZoneSettingValue(id: string, value: string): unknown {
  const meta = SETTING_META[id];
  if (meta?.control === "number") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (value === "on" || value === "off") return value;
  if (/^-?\d+$/.test(value.trim())) return Number(value.trim());
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}
