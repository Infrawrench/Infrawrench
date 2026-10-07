/**
 * Vast passes environment variables and port mappings as one Docker-flag
 * string (`-e KEY=value -p 8080:8080`), on templates and at instance creation.
 * The forms take friendlier inputs (KEY=value lines, a port list) and these
 * helpers convert both ways. Values are never read back into inventory: only
 * variable names and ports are.
 */

/** Quote a flag value the way a shell would need it, only when it must. */
function quote(v: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `KEY=value` lines and a `8080, 8000/udp` port list → `-e KEY=value -p 8080:8080 ...`. */
export function buildDockerFlags(
  envText: string | undefined,
  portsText: string | undefined,
): string {
  const parts: string[] = [];
  for (const raw of (envText ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    parts.push(`-e ${key}=${quote(line.slice(eq + 1))}`);
  }
  for (const raw of (portsText ?? "").split(/[,\s]+/)) {
    const m = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(raw.trim());
    if (!m) continue;
    parts.push(`-p ${m[1]}:${m[1]}${m[2] ? `/${m[2].toLowerCase()}` : ""}`);
  }
  return parts.join(" ");
}

/** Variable names in a Docker-flag string (values deliberately dropped). */
export function envKeysOf(flags: string | undefined): string[] {
  const keys = new Set<string>();
  for (const m of (flags ?? "").matchAll(/(?:^|\s)-e\s+["']?([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    keys.add(m[1]!);
  }
  return [...keys].sort();
}

/** Container ports in a Docker-flag string, e.g. `8080, 8000/udp`. */
export function portsOf(flags: string | undefined): string[] {
  const ports: string[] = [];
  for (const m of (flags ?? "").matchAll(/(?:^|\s)-p\s+(?:\d+:)?(\d+)(\/(?:tcp|udp))?/g)) {
    ports.push(`${m[1]}${m[2] ?? ""}`);
  }
  return ports;
}

/**
 * The same inputs in the object form instance creation takes, which is what
 * `vastai create instance` sends (`parse_env`): `{KEY: value}` for variables
 * and `{"-p 8080:8080": "1"}` for ports.
 */
export function buildEnvObject(
  envText: string | undefined,
  portsText: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (envText ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = line.slice(eq + 1);
  }
  for (const raw of (portsText ?? "").split(/[,\s]+/)) {
    const m = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(raw.trim());
    if (m) out[`-p ${m[1]}:${m[1]}${m[2] ? `/${m[2].toLowerCase()}` : ""}`] = "1";
  }
  return out;
}
