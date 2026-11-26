import { describe, expect, it } from "vitest";
import { MASK, entropy, looksRandom, maskSecrets } from "../masking";

/**
 * Every credential here is assembled at run time from a prefix and filler,
 * so no line of this file is itself the shape a secret scanner looks for.
 */
const filler = (length: number, alphabet = "aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0z"): string =>
  Array.from({ length }, (_, i) => alphabet[(i * 7) % alphabet.length]).join("");
const hex = (length: number): string => filler(length, "0123456789abcdef");

describe("maskSecrets", () => {
  it("masks credentials by their shape", () => {
    const pat = `iwg_${"a".repeat(32)}`;
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(20)}.${"c".repeat(10)}`;
    const masked = maskSecrets(`pushed with ${pat}, then called the API with ${jwt}`);
    expect(masked).toBe(`pushed with ${MASK}, then called the API with ${MASK}`);
  });

  it("masks every token this forge and the app mint", () => {
    for (const prefix of ["iwg_", "iwk_", "iwj_", "iwr_", "iwc_"]) {
      const token = `${prefix}${filler(40)}`;
      expect(maskSecrets(`before ${token} after`)).toBe(`before ${MASK} after`);
    }
    // A job token has a dot between its claims and its signature.
    expect(maskSecrets(`IW_GIT_JOB=iwj_${filler(60)}.${filler(43)}`)).not.toContain(filler(10));
  });

  it.each([
    ["a GitHub personal token", `ghp_${filler(36)}`],
    ["a GitHub fine-grained token", `github_pat_${filler(22)}_${filler(40)}`],
    ["a GitHub app token", `ghs_${filler(36)}`],
    ["a GitLab token", `glpat-${filler(20)}`],
    ["a Slack bot token", `xoxb-${"1".repeat(12)}-${filler(24)}`],
    [
      "a Slack webhook",
      `https://hooks.slack.com/services/T${filler(8)}/B${filler(8)}/${filler(24)}`,
    ],
    ["a Discord webhook", `https://discord.com/api/webhooks/${"1".repeat(18)}/${filler(60)}`],
    ["a Stripe secret key", `sk_live_${filler(24)}`],
    ["a Stripe restricted key", `rk_test_${filler(24)}`],
    ["a Stripe webhook secret", `whsec_${filler(32)}`],
    ["an npm token", `npm_${filler(36)}`],
    ["a PyPI token", `pypi-${filler(50)}`],
    ["an AWS access key id", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["an AWS temporary key id", `ASIA${"ABCDEFGHIJKLMNOP"}`],
    ["a Google API key", `AIza${filler(35)}`],
    ["a Google OAuth token", `ya29.${filler(40)}`],
    ["a model provider key", `sk-${filler(40)}`],
    ["an Anthropic key", `sk-ant-api03-${filler(40)}`],
    ["a Hugging Face token", `hf_${filler(34)}`],
    ["a DigitalOcean token", `dop_v1_${hex(64)}`],
    ["a SendGrid key", `SG.${filler(22)}.${filler(43)}`],
    ["a Vault token", `hvs.${filler(24)}`],
    ["a Sentry token", `sntrys_${filler(40)}`],
    ["a Linear key", `lin_api_${filler(40)}`],
    ["a Supabase token", `sbp_${filler(40)}`],
    ["a Twilio key", `SK${hex(32)}`],
    ["an age key", `AGE-SECRET-KEY-1${"Q".repeat(40)}`],
  ])("masks %s", (_name, secret) => {
    const masked = maskSecrets(`ran the deploy with ${secret} and it passed`);
    expect(masked).toBe(`ran the deploy with ${MASK} and it passed`);
  });

  it("masks a private key block whole", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(maskSecrets(`key:\n${key}\ndone`)).toBe(`key:\n${MASK}\ndone`);
  });

  it("masks every kind of private key block, and one that was cut short", () => {
    for (const kind of ["RSA ", "EC ", "", "ENCRYPTED ", "OPENSSH "]) {
      const key = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIabc\n-----END ${kind}PRIVATE KEY-----`;
      expect(maskSecrets(`a\n${key}\nb`)).toBe(`a\n${MASK}\nb`);
    }
    const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nxyz\n-----END PGP PRIVATE KEY BLOCK-----";
    expect(maskSecrets(pgp)).toBe(MASK);
    // The excerpt ended inside the key: everything from its first line goes.
    expect(maskSecrets("log\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef")).toBe(
      `log\n${MASK}`,
    );
    // A public key is not a secret.
    const pub = "-----BEGIN PUBLIC KEY-----\nMIIabc\n-----END PUBLIC KEY-----";
    expect(maskSecrets(pub)).toBe(pub);
  });

  it("masks what a name says is a secret, and keeps the name", () => {
    expect(maskSecrets("DATABASE_PASSWORD=hunter2 PORT=5432")).toBe(
      `DATABASE_PASSWORD=${MASK} PORT=5432`,
    );
    expect(maskSecrets('{"apiKey": "abc123", "region": "eu"}')).toBe(
      `{"apiKey": "${MASK}", "region": "eu"}`,
    );
    expect(maskSecrets("aws_secret_access_key = abcDEF123/xyz+456")).toBe(
      `aws_secret_access_key = ${MASK}`,
    );
    expect(maskSecrets("client_secret: 'shh'\nSIGNING_KEY=abc")).toBe(
      `client_secret: '${MASK}'\nSIGNING_KEY=${MASK}`,
    );
    expect(maskSecrets("export SENTRY_DSN=abc123")).toBe(`export SENTRY_DSN=${MASK}`);
  });

  it("masks a password in a URL and an authorization header", () => {
    expect(maskSecrets("postgres://app:s3cret@db.internal:5432/app")).toBe(
      `postgres://app:${MASK}@db.internal:5432/app`,
    );
    expect(maskSecrets("curl -H 'Authorization: Bearer abcdefgh12345678' https://x")).toContain(
      `Bearer ${MASK}`,
    );
  });

  it("masks a token in a URL's user part", () => {
    expect(maskSecrets(`git clone https://${filler(40)}@example.com/a/b.git`)).toBe(
      `git clone https://${MASK}@example.com/a/b.git`,
    );
    // An ordinary user name stays.
    expect(maskSecrets("ssh://git@git.infrawrench.com/acme/infra.git")).toBe(
      "ssh://git@git.infrawrench.com/acme/infra.git",
    );
  });

  it("masks an authorization header whatever its scheme", () => {
    expect(maskSecrets("Authorization: token abc123def456")).toBe(`Authorization: token ${MASK}`);
    expect(maskSecrets("authorization: abc123def456")).toBe(`authorization: ${MASK}`);
    expect(maskSecrets('{"Authorization": "Bearer abc123def456ghi"}')).toBe(
      `{"Authorization": "Bearer ${MASK}"}`,
    );
    expect(maskSecrets("Proxy-Authorization: Basic dXNlcjpwYXNz")).toBe(
      `Proxy-Authorization: Basic ${MASK}`,
    );
  });

  it("masks cookies", () => {
    expect(maskSecrets("Cookie: __Host-iwg-session=v1.abc.def.ghi; theme=dark\nHost: x")).toBe(
      `Cookie: ${MASK}\nHost: x`,
    );
    expect(maskSecrets("< set-cookie: sid=abc123; Path=/; HttpOnly")).toBe(`< set-cookie: ${MASK}`);
  });

  it("masks a token header whatever it is called", () => {
    expect(maskSecrets("X-Auth-Token: abc123def456")).toBe(`X-Auth-Token: ${MASK}`);
    expect(maskSecrets("token: Bearer abcdefgh12345678")).toBe(`token: Bearer ${MASK}`);
    expect(maskSecrets("x-api-key: abc123def456")).toBe(`x-api-key: ${MASK}`);
  });

  it("masks the value of a flag named for a secret", () => {
    expect(maskSecrets("mysql --password hunter2 --host db")).toBe(
      `mysql --password ${MASK} --host db`,
    );
    expect(maskSecrets("deploy --api-key=abc123 --region eu")).toBe(
      `deploy --api-key=${MASK} --region eu`,
    );
    expect(maskSecrets("tool --token 'a b c' run")).toBe(`tool --token '${MASK}' run`);
    // A flag with no value keeps the next flag.
    expect(maskSecrets("tool --password --verbose")).toBe("tool --password --verbose");
  });

  it("masks the password given to curl", () => {
    expect(maskSecrets("curl -u deploy:hunter2 https://x")).toBe(
      `curl -u deploy:${MASK} https://x`,
    );
    expect(maskSecrets("curl --user 'deploy:hunter2' https://x")).toBe(
      `curl --user 'deploy:${MASK}' https://x`,
    );
  });

  it("masks a random-looking value given to a configuration name", () => {
    const random = filler(40);
    expect(maskSecrets(`CLOUDFLARE_ZONE=${random}`)).toBe(`CLOUDFLARE_ZONE=${MASK}`);
    expect(maskSecrets(`export SOMETHING="${random}"`)).toBe(`export SOMETHING="${MASK}"`);
    expect(maskSecrets(`UPLOAD_ID=${hex(64)}`)).toBe(`UPLOAD_ID=${MASK}`);
  });

  it("keeps configuration that is not random", () => {
    for (const text of [
      // A commit id is what a trace is full of.
      `GIT_COMMIT=${hex(40)}`,
      "NODE_ENV=production PORT=5432",
      "SERVICE_NAME=my-long-service-name-production",
      "BUILD_DIR=/Users/someone/Projects/Infrawrench2026/build",
      "IMAGE=registry.example.com/acme/Service2:v1.2.3",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  it("leaves ordinary text alone", () => {
    for (const text of [
      "Ran `pnpm test` in src/auth: 42 passed. Decided to keep the token cache.",
      "Changed src/auth/token.ts: 3 lines. The password field is required now.",
      "The global-configuration-settings module and the sk-learn dependency are untouched.",
      "See https://git.infrawrench.com/acme/infra/pull/12 and commit " + hex(40) + ".",
      "```ts\nconst limit = 30;\nexport const pageSize = (n: number) => Math.min(n, limit);\n```",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  it("masks the same text the same way twice", () => {
    const text = [
      `Authorization: Bearer ${filler(30)}`,
      `DATABASE_URL=postgres://app:${filler(12)}@db:5432/app`,
      `{"password": "${filler(12)}"}`,
      `--token ${filler(20)}`,
      `KEY_MATERIAL=${filler(44)}`,
    ].join("\n");
    const once = maskSecrets(text);
    expect(once).not.toContain(filler(12));
    expect(maskSecrets(once)).toBe(once);
  });

  it("takes one pass over a long line of anything", () => {
    for (const character of ["a", "-", "=", ":", " ", "A", "/"]) {
      const started = performance.now();
      maskSecrets(character.repeat(200_000));
      expect(performance.now() - started).toBeLessThan(2_000);
    }
    const started = performance.now();
    maskSecrets("token ".repeat(30_000) + "--password ".repeat(10_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("looksRandom", () => {
  it("tells a generated value from a written one", () => {
    expect(looksRandom(filler(40))).toBe(true);
    expect(looksRandom(hex(64))).toBe(true);
    expect(looksRandom(hex(40))).toBe(false);
    expect(looksRandom("aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(looksRandom("my-long-service-name-production")).toBe(false);
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });
});
