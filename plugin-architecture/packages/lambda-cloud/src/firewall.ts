import type { LFirewallRule } from "./types.js";

/**
 * Firewall rules are edited as text, one rule per line:
 *
 *     tcp 22 0.0.0.0/0 SSH
 *     tcp 8000-8100 10.0.0.0/8 internal APIs
 *     icmp - 0.0.0.0/0 ping
 *     all - 203.0.113.4/32 office
 *
 * `protocol ports source description`, where ports is a single port, an
 * inclusive `min-max` range, or `-` (required for icmp, which takes no
 * ports). Lambda requires a port range for tcp, udp and all; `-` there means
 * every port. The description is the rest of the line.
 */

const PROTOCOLS = new Set(["tcp", "udp", "icmp", "all"]);

export function formatRule(r: LFirewallRule): string {
  const range = r.port_range;
  const ports = !range ? "-" : range[0] === range[1] ? String(range[0]) : `${range[0]}-${range[1]}`;
  return [r.protocol, ports, r.source_network, r.description].filter((x) => x !== "").join(" ");
}

export function formatRules(rules: LFirewallRule[] | undefined): string {
  return (rules ?? []).map(formatRule).join("\n");
}

export function parseRules(text: string): LFirewallRule[] {
  const rules: LFirewallRule[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  lines.forEach((line, i) => {
    if (!line || line.startsWith("#")) return;
    const [proto, ports, source, ...rest] = line.split(/\s+/);
    const protocol = (proto ?? "").toLowerCase();
    if (!PROTOCOLS.has(protocol)) {
      throw new Error(`Firewall rule line ${i + 1}: protocol must be tcp, udp, icmp or all`);
    }
    if (!source || !/^[\d.]+\/\d{1,2}$/.test(source)) {
      throw new Error(`Firewall rule line ${i + 1}: source must be an IPv4 CIDR such as 0.0.0.0/0`);
    }
    const rule: LFirewallRule = {
      protocol: protocol as LFirewallRule["protocol"],
      source_network: source,
      description: rest.join(" "),
    };
    if (protocol !== "icmp") {
      if (!ports || ports === "-" || ports === "*") {
        rule.port_range = [1, 65535];
      } else {
        const m = /^(\d+)(?:-(\d+))?$/.exec(ports);
        if (!m) throw new Error(`Firewall rule line ${i + 1}: ports must be a port, a range or -`);
        const lo = Number(m[1]);
        const hi = Number(m[2] ?? m[1]);
        if (lo < 1 || hi > 65535 || lo > hi) {
          throw new Error(`Firewall rule line ${i + 1}: ports must be within 1-65535`);
        }
        rule.port_range = [lo, hi];
      }
    }
    rules.push(rule);
  });
  return rules;
}

/** True when any rule lets the whole internet in. */
export function openToInternet(rules: LFirewallRule[] | undefined): boolean {
  return (rules ?? []).some((r) => r.source_network === "0.0.0.0/0");
}

/** True when SSH (tcp 22) is reachable from the whole internet. */
export function sshOpenToInternet(rules: LFirewallRule[] | undefined): boolean {
  return (rules ?? []).some(
    (r) =>
      r.source_network === "0.0.0.0/0" &&
      (r.protocol === "tcp" || r.protocol === "all") &&
      (!r.port_range || (r.port_range[0] <= 22 && r.port_range[1] >= 22)),
  );
}
