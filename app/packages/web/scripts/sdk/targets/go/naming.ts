/**
 * Go identifier casing, split out of the target so the docs code-sample
 * renderer (`../../code-samples.ts`) can print Go field and namespace names
 * without importing the whole emitter (which reads its runtime template from
 * disk at generate time).
 */
import { words } from "../../naming";

/**
 * Words Go spells in full caps. `go vet` does not enforce this, but every Go
 * reviewer does, and `OrgId` next to `URL` in the same struct reads as a bug.
 */
const INITIALISMS = new Set([
  "acl",
  "api",
  "ascii",
  "aws",
  "cpu",
  "css",
  "db",
  "dns",
  "eof",
  "gcp",
  "guid",
  "html",
  "http",
  "https",
  "id",
  "ip",
  "json",
  "kv",
  "mfa",
  "otp",
  "ovh",
  "ram",
  "rpc",
  "sftp",
  "smtp",
  "sql",
  "ssh",
  "ssl",
  "tcp",
  "tls",
  "totp",
  "ttl",
  "udp",
  "ui",
  "uid",
  "uri",
  "url",
  "utf8",
  "uuid",
  "vm",
  "xml",
  "yaml",
]);

/** Words whose Go spelling is neither title case nor all caps. */
const WORD_OVERRIDES = new Map([
  ["ids", "IDs"],
  ["nosql", "NoSQL"],
  ["oauth", "OAuth"],
  ["ok", "OK"],
]);

function goWord(word: string): string {
  const lower = word.toLowerCase();
  const override = WORD_OVERRIDES.get(lower);
  if (override !== undefined) return override;
  if (INITIALISMS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `sshKeyId` → `SSHKeyID`. Every generated identifier is exported. */
export function exported(name: string): string {
  return words(name).map(goWord).join("");
}
