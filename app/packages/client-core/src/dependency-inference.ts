/**
 * Dependency inference from synced cloud data.
 *
 * The dependency graph used to be built purely from output references, which
 * only exist once someone wires one by hand — so for most orgs the canvas was
 * empty even though the topology was already sitting in the synced resource
 * rows. Every poll writes each resource's `fields` bag, its `externalId` and
 * its `parentResourceId`, and providers put the wiring right there: an EC2
 * instance's `vpcId` is a VPC's external id, a DNS record's content is a
 * droplet's public IP, a GenAI agent's `projectId` is a project's uuid.
 *
 * This module reads that data back out. The host stays provider-agnostic — it
 * never learns what a "vpcId" is. Three mechanisms, in descending order of
 * confidence:
 *
 * 1. **Declared** — a plugin's `dependsOn` rules on a resource type say which
 *    field points at which type. The plugin knows its own provider, so a
 *    declaration beats anything the host could work out.
 * 2. **Containment** — `parentResourceId` is already an explicit link written
 *    by the sync path (cluster → deployment, project → database).
 * 3. **Identifier match** — index every resource by the values that identify it
 *    (external id, name, uuid, arn, endpoint, IP…), then look up each
 *    resource's field values in that index. An exact hit is an edge.
 *
 * Matching is exact, never substring: `"vpc-0a1b"` inside a connection string
 * is not a reference we can attribute to a field, and prefix matching turns
 * short names into a mess. The noise controls that keep the *guessed* half
 * honest are documented on the constants below — ambiguous tokens are dropped
 * entirely, weak tokens only match inside one account, and descriptive fields
 * (status, region, …) never source a match. Declared rules skip those guards,
 * because a rule that names a target type has already resolved the ambiguity
 * they exist to avoid.
 */

import type { ResourceDependencyRule } from "@infrawrench/plugin-base";
import type { DependencyGraphEdge } from "./dependency-graph";

/** The synced state one resource contributes to inference. */
export interface InferenceResource {
  id: string;
  accountId: string;
  /** Needed to look up the plugin's `dependsOn` rules and to scope their targets. */
  pluginId?: string;
  resourceTypeId?: string;
  /** The provider's own id for the resource, when the plugin reports one. */
  externalId?: string | null;
  /** Set by the sync path for child resources (k8s pod → cluster, …). */
  parentResourceId?: string | null;
  /** The non-secret `fields` bag as stored by the poller. */
  fields?: Record<string, unknown> | null;
  /** Resolved outputs — read for identity only, never as a reference source. */
  outputs?: Record<string, unknown> | null;
}

/**
 * Plugin-declared rules, keyed by `dependencyRuleKey(pluginId, resourceTypeId)`.
 * Hosts build this from the loaded plugins' resource types — see
 * `collectDependencyRules`.
 */
export type DependencyRuleSet = Record<string, ResourceDependencyRule[]>;

/** The key `DependencyRuleSet` is indexed by. */
export function dependencyRuleKey(pluginId: string, resourceTypeId: string): string {
  return `${pluginId}:${resourceTypeId}`;
}

/**
 * Index every loaded plugin's `dependsOn` declarations into a `DependencyRuleSet`.
 * Takes the plugin shape structurally so hosts can pass their own loaded-plugin
 * records without this module depending on the loader.
 */
export function collectDependencyRules(
  plugins: {
    id: string;
    resourceTypes: { id: string; dependsOn?: ResourceDependencyRule[] }[];
  }[],
): DependencyRuleSet {
  const rules: DependencyRuleSet = {};
  for (const plugin of plugins) {
    for (const type of plugin.resourceTypes) {
      if (type.dependsOn?.length) rules[dependencyRuleKey(plugin.id, type.id)] = type.dependsOn;
    }
  }
  return rules;
}

export interface InferDependencyEdgesOptions {
  /** Plugin-declared rules; see `collectDependencyRules`. */
  rules?: DependencyRuleSet;
  /**
   * Edges already known from output references. Their (consumer, provider)
   * pairs are skipped: an explicit reference says the same thing with better
   * provenance, and drawing both stacks two curves on one path.
   */
  existingEdges?: DependencyGraphEdge[];
  /**
   * Keep only edges with this resource at one end. The whole resource set is
   * still scanned, so ambiguity detection stays intact.
   */
  focusResourceId?: string;
  /** Cap on returned edges. Default 4000 — beyond that the canvas is unusable. */
  maxEdges?: number;
}

export interface InferredDependencyEdges {
  edges: DependencyGraphEdge[];
  /** True when `maxEdges` dropped edges that would otherwise have been returned. */
  truncated: boolean;
}

/**
 * Field keys whose value identifies the resource itself. Used to build the
 * lookup index — a resource is findable by any of these, not just its external
 * id, because plugins reference each other by name and address as often as by
 * id (a target group is referenced by name, a DNS record points at an IP).
 *
 * Exported because the DNS surface (`./dns`) answers the same question of the
 * same rows — "does anything in this workspace answer to this value?" — and a
 * second, drifting definition of identity would make a record read as owned on
 * the canvas and dangling on the Domains view.
 */
export const IDENTITY_FIELD_KEYS: ReadonlySet<string> = new Set([
  "id",
  "uuid",
  "arn",
  "urn",
  "name",
  "slug",
  "identifier",
  "externalid",
  "selflink",
  "endpoint",
  "host",
  "hostname",
  "fqdn",
  "domain",
  "address",
  "ip",
  "ipv4",
  "ipv6",
  "publicip",
  "publicipv4",
  "privateip",
]);

/**
 * Consumer field keys that never source a reference. These carry provider
 * vocabulary (`region: "nyc3"`, `status: "active"`) that can collide with a
 * resource name and produce an edge nobody asked for. Anything not listed here
 * is fair game — `zone`, `network`, `cluster` and friends really are pointers.
 */
const NON_REFERENCE_FIELD_KEYS = new Set([
  "status",
  "state",
  "health",
  "region",
  "location",
  "size",
  "tier",
  "plan",
  "class",
  "type",
  "kind",
  "version",
  "engine",
  "tags",
  "labels",
  "description",
  "comment",
  "notes",
  "instruction",
  "createdat",
  "updatedat",
  "lastseen",
  "displayname",
]);

/** Shortest token allowed to match at all — below this, collisions dominate. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Shortest token allowed to match *across accounts*. Within one account a
 * bare name ("prod", "default") is a plausible pointer; across accounts it is
 * a coincidence waiting to happen, so cross-account matches also have to look
 * like a machine-generated identifier (see `isStrongToken`).
 */
const MIN_STRONG_TOKEN_LENGTH = 7;

/**
 * Does this token look machine-generated rather than human-chosen? Digits plus
 * a separator covers what providers actually mint — uuids, `vpc-0a1b2c3d`,
 * arns, IPv4 addresses, hostnames — while rejecting words like `production`.
 */
function isStrongToken(token: string): boolean {
  if (token.length < MIN_STRONG_TOKEN_LENGTH) return false;
  return /[0-9]/.test(token) && /[-.:_/]/.test(token);
}

/** Lowercased for lookup: hostnames and most provider ids are case-folded anyway. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The tokens a value could be pointing at. Plugins flatten arrays into
 * comma-joined strings (`securityGroups: "sg-a,sg-b"`), so the parts count as
 * candidates alongside the whole value.
 */
function candidateTokens(value: unknown, minNumericLength = MIN_STRONG_TOKEN_LENGTH): string[] {
  if (typeof value === "number") {
    // Numeric ids (DO droplet ids and the like) are real, but short numbers are
    // ports, counts and sizes — those must not match anything unless a rule
    // asked for this field by name, in which case the caller lowers the floor.
    const asText = String(value);
    return asText.length >= minNumericLength && Number.isInteger(value) ? [asText] : [];
  }
  if (typeof value !== "string") return [];
  const whole = normalize(value);
  if (!whole) return [];
  if (!whole.includes(",")) return [whole];
  const parts = whole
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return [whole, ...parts];
}

interface IndexEntry {
  resourceId: string;
  accountId: string;
  pluginId: string | undefined;
  resourceTypeId: string | undefined;
  /**
   * Every identity this resource answers to the token under — `externalId`,
   * `name`, `endpoint`… A resource can hold the same value under several keys,
   * and a rule may name any one of them as its `targetKey`.
   */
  identityKeys: string[];
}

/**
 * How many claimants of one token are kept **per resource type**. Beyond a
 * couple, same-typed claimants only prove the token is ambiguous for that type
 * — which two already establish — so the rest are dropped as duplicates of a
 * conclusion we've reached.
 *
 * Capping per type rather than per token is load-bearing. GCP auto-mode VPCs
 * name the network `default` *and* one subnet per region `default`: a per-token
 * cap discards the token entirely, taking the network with it, and a rule that
 * says "this field names a vpc-network" resolves nothing. Per type, the network
 * survives alongside a few subnets, and the rule picks it out.
 */
const MAX_CLAIMS_PER_TYPE = 4;

/** Absolute per-token bound, so a value shared across dozens of types stays finite. */
const MAX_TOKEN_CLAIMS = 64;

/**
 * Identity index: token → every resource that answers to it. The heuristic pass
 * only trusts a token claimed by exactly one resource (two things called
 * "default" are poison, and a wrong edge is worse than a missing one); a
 * declared rule can pick its target out of the list by type.
 *
 * Note the caps never reduce a list to one entry — with at least two claimants,
 * at least two survive — so trimming can't fabricate the uniqueness the
 * heuristic pass requires.
 */
function buildIdentityIndex(
  resources: InferenceResource[],
  extraIdentityKeys: ExtraIdentityKeys,
): Map<string, IndexEntry[]> {
  const index = new Map<string, IndexEntry[]>();

  /**
   * One entry per (token, resource), listing **every** key that resource
   * answers to the token under. Keeping only the first key looks harmless
   * — `externalId` wins, and it is the default `targetKey` — but it silently
   * disables any rule matching on a key whose value equals the external id
   * (`targetKey: "name"` against a type where `externalId === name`, which is
   * true of `azure-resource-group` and `aws/target-group`). Merging instead
   * keeps the claimant count at one, so the heuristic pass still sees the
   * uniqueness it requires.
   */
  const claim = (token: string, base: Omit<IndexEntry, "identityKeys">, identityKey: string) => {
    if (!token) return;
    const existing = index.get(token);
    if (!existing) {
      index.set(token, [{ ...base, identityKeys: [identityKey] }]);
      return;
    }
    const mine = existing.find((e) => e.resourceId === base.resourceId);
    if (mine) {
      if (!mine.identityKeys.includes(identityKey)) mine.identityKeys.push(identityKey);
      return;
    }
    if (existing.length >= MAX_TOKEN_CLAIMS) return;
    let sameType = 0;
    for (const e of existing) {
      if (e.resourceTypeId === base.resourceTypeId) sameType++;
    }
    if (sameType >= MAX_CLAIMS_PER_TYPE) return;
    existing.push({ ...base, identityKeys: [identityKey] });
  };

  for (const resource of resources) {
    const base = {
      resourceId: resource.id,
      accountId: resource.accountId,
      pluginId: resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
    };
    if (resource.externalId) {
      claim(normalize(resource.externalId), base, "externalId");
    }
    for (const bag of [resource.fields, resource.outputs]) {
      for (const [key, value] of Object.entries(bag ?? {})) {
        if (!isIdentityKey(key.toLowerCase(), resource, extraIdentityKeys)) continue;
        // Numeric floor of 1: a rule may target a short numeric id, and the
        // heuristic pass applies its own length rules on the consumer side.
        for (const token of candidateTokens(value, 1)) {
          claim(token, base, key);
        }
      }
    }
  }

  return index;
}

/**
 * Target keys named by rules that aren't identity keys by default — those have
 * to be indexed too, or a rule pointing at `clusterName` would never match.
 *
 * Scoped to the plugin (and type, when the rule names one) the rule actually
 * targets. A flat set would make one plugin's choice everyone's problem: a
 * Docker rule matching images on `tags` would turn every `tags` field in the
 * app — DigitalOcean's, Mistral's — into an identity, so unrelated resources
 * would become findable by tag value in the guessing pass.
 */
interface ExtraIdentityKeys {
  /** `pluginId` → keys, for rules that name no target type. */
  anyType: Map<string, Set<string>>;
  /** `pluginId:resourceTypeId` → keys. */
  byType: Map<string, Set<string>>;
}

function extraIdentityKeysFrom(rules: DependencyRuleSet): ExtraIdentityKeys {
  const anyType = new Map<string, Set<string>>();
  const byType = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, mapKey: string, value: string) => {
    const set = map.get(mapKey);
    if (set) set.add(value);
    else map.set(mapKey, new Set([value]));
  };

  for (const [ruleKey, ruleList] of Object.entries(rules)) {
    // The rule set is keyed by the *consumer* — its plugin is also the default
    // target plugin, since most references stay inside one provider.
    const consumerPluginId = ruleKey.slice(0, ruleKey.indexOf(":"));
    for (const rule of ruleList) {
      const key = rule.targetKey?.toLowerCase();
      if (!key || key === "externalid") continue;
      const targetPluginId = rule.targetPluginId ?? consumerPluginId;
      if (!targetPluginId) continue;
      if (rule.targetTypeId) {
        add(byType, dependencyRuleKey(targetPluginId, rule.targetTypeId), key);
      } else {
        add(anyType, targetPluginId, key);
      }
    }
  }
  return { anyType, byType };
}

/** Is `lowerKey` an identity key for this resource — globally, or by a rule that targets it? */
function isIdentityKey(
  lowerKey: string,
  resource: InferenceResource,
  extra: ExtraIdentityKeys,
): boolean {
  if (IDENTITY_FIELD_KEYS.has(lowerKey)) return true;
  if (!resource.pluginId) return false;
  if (extra.anyType.get(resource.pluginId)?.has(lowerKey)) return true;
  if (!resource.resourceTypeId) return false;
  return (
    extra.byType
      .get(dependencyRuleKey(resource.pluginId, resource.resourceTypeId))
      ?.has(lowerKey) ?? false
  );
}

/**
 * Build a rule's `matchTemplate` into the values to look up — `"{a}/{b}"` with
 * this resource's own field values substituted in.
 *
 * A placeholder that is missing, empty or non-scalar aborts the whole
 * composition: a key built from half its parts (`"/main"`) is not a weaker
 * match, it is a different string that could collide with something real.
 *
 * One placeholder may hold a comma-joined list, in which case the template is
 * expanded per element — `"{namespace}/{configMaps}"` over `"a, b"` yields
 * `["prod/a", "prod/b"]`. Composing first and splitting afterwards (which is
 * what the plain field path does) would qualify only the first element and
 * leave a bare `b` to match something unrelated. Two list-valued placeholders
 * would need a cartesian product whose meaning is anyone's guess, so that
 * aborts instead.
 */
function composeMatchValues(
  template: string,
  bag: Record<string, unknown> | null | undefined,
): string[] {
  const placeholders = [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => (m[1] ?? "").trim());
  const resolved = new Map<string, string[]>();

  for (const key of placeholders) {
    if (resolved.has(key)) continue;
    const value = bag?.[key];
    let parts: string[];
    if (typeof value === "string" && value.trim()) {
      parts = value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      parts = [String(value)];
    } else {
      return [];
    }
    if (parts.length === 0) return [];
    resolved.set(key, parts);
  }

  const listKeys = [...resolved.entries()].filter(([, parts]) => parts.length > 1);
  if (listKeys.length > 1) return [];

  const substitute = (pick: (key: string) => string) =>
    template.replace(/\{([^{}]+)\}/g, (_whole, key: string) => pick(key.trim()));

  if (listKeys.length === 0) {
    return [substitute((key) => resolved.get(key)?.[0] ?? "")];
  }
  const [listKey, listParts] = listKeys[0]!;
  return listParts.map((part) =>
    substitute((key) => (key === listKey ? part : (resolved.get(key)?.[0] ?? ""))),
  );
}

/**
 * Resolve one declared rule against the index. The rule's constraints do the
 * disambiguating: type, plugin and the identity key it says to match on. If
 * more than one resource still fits, prefer one in the consumer's own account —
 * and if that doesn't settle it, emit nothing rather than pick.
 */
function resolveDeclaredTarget(
  entries: IndexEntry[],
  rule: ResourceDependencyRule,
  consumer: InferenceResource,
): IndexEntry | null {
  const wantPlugin = rule.targetPluginId ?? consumer.pluginId;
  const wantKey = (rule.targetKey ?? "externalId").toLowerCase();
  const matches = entries.filter((entry) => {
    if (entry.resourceId === consumer.id) return false;
    if (!entry.identityKeys.some((key) => key.toLowerCase() === wantKey)) return false;
    if (rule.targetTypeId && entry.resourceTypeId !== rule.targetTypeId) return false;
    // An unknown plugin id on either side means the host didn't supply one;
    // don't invent a mismatch out of missing data.
    if (wantPlugin && entry.pluginId && entry.pluginId !== wantPlugin) return false;
    return true;
  });
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length === 0) return null;
  const sameAccount = matches.filter((entry) => entry.accountId === consumer.accountId);
  return sameAccount.length === 1 ? (sameAccount[0] ?? null) : null;
}

/**
 * Derive depends-on edges from what the last sync already told us about each
 * resource, plus whatever the plugins declared. Returned edges carry
 * `kind: "declared" | "containment" | "field-match"` so hosts can render them
 * differently from hand-wired output references.
 *
 * Edges are deduped per (consumer, provider): one arrow per relationship, even
 * when three fields all point at the same VPC. The passes run in confidence
 * order — declared, then containment, then guessed — so the better-sourced edge
 * wins the pair, and the ordering is stable, which means the cap truncates
 * predictably rather than shuffling the graph between polls.
 */
export function inferDependencyEdges(
  resources: InferenceResource[],
  options: InferDependencyEdgesOptions = {},
): InferredDependencyEdges {
  const maxEdges = options.maxEdges ?? 4000;
  const focusId = options.focusResourceId ?? null;
  const rules = options.rules ?? {};
  const byId = new Map(resources.map((r) => [r.id, r]));
  const index = buildIdentityIndex(resources, extraIdentityKeysFrom(rules));

  // Pairs already explained by an output reference, plus the pairs this pass
  // has emitted — both live in one set so the dedupe is a single lookup.
  const seenPairs = new Set<string>();
  for (const edge of options.existingEdges ?? []) {
    seenPairs.add(`${edge.consumerResourceId} ${edge.providerResourceId}`);
  }

  const edges: DependencyGraphEdge[] = [];
  let truncated = false;

  const emit = (edge: DependencyGraphEdge): void => {
    if (edge.consumerResourceId === edge.providerResourceId) return;
    const pair = `${edge.consumerResourceId} ${edge.providerResourceId}`;
    if (seenPairs.has(pair)) return;
    if (focusId && edge.consumerResourceId !== focusId && edge.providerResourceId !== focusId) {
      return;
    }
    seenPairs.add(pair);
    if (edges.length >= maxEdges) {
      truncated = true;
      return;
    }
    edges.push(edge);
  };

  // Fields a rule already speaks for. The guessing pass leaves these alone
  // even when the rule found nothing: the plugin said what the field means, so
  // a match against some other type would be a worse answer than no answer.
  const declaredFields = new Set<string>();

  // Declared rules first — the plugin knows its own provider, so its answer
  // outranks both the parent link and anything the index would guess.
  for (const resource of resources) {
    if (!resource.pluginId || !resource.resourceTypeId) continue;
    const ruleList = rules[dependencyRuleKey(resource.pluginId, resource.resourceTypeId)];
    if (!ruleList) continue;
    for (const rule of ruleList) {
      if (rule.from !== "outputs") declaredFields.add(`${resource.id}|${rule.fieldKey}`);
      const bag = rule.from === "outputs" ? resource.outputs : resource.fields;
      // Composed values are already per-element and must not be re-split — a
      // composite key can legitimately contain a comma. Floor of 1 on the plain
      // path: the rule named this field, so a two-character namespace or a
      // short numeric id is exactly what it meant.
      const tokens = rule.matchTemplate
        ? composeMatchValues(rule.matchTemplate, bag).map(normalize).filter(Boolean)
        : candidateTokens(bag?.[rule.fieldKey], 1);
      for (const token of tokens) {
        const target = resolveDeclaredTarget(index.get(token) ?? [], rule, resource);
        if (!target) continue;
        emit({
          consumerResourceId: resource.id,
          consumerFieldKey: rule.fieldKey,
          providerResourceId: target.resourceId,
          // The key the rule asked to match on, not whichever one the index
          // happened to record first.
          providerOutputKey: rule.targetKey ?? "externalId",
          kind: "declared",
          ...(rule.label ? { label: rule.label } : {}),
        });
      }
    }
  }

  // Then containment: `parentResourceId` is written by the sync path itself,
  // so it is the one un-declared edge that involves no guessing.
  for (const resource of resources) {
    if (!resource.parentResourceId) continue;
    if (!byId.has(resource.parentResourceId)) continue;
    emit({
      consumerResourceId: resource.id,
      consumerFieldKey: "parent",
      providerResourceId: resource.parentResourceId,
      providerOutputKey: "id",
      kind: "containment",
    });
  }

  for (const resource of resources) {
    for (const [key, value] of Object.entries(resource.fields ?? {})) {
      if (NON_REFERENCE_FIELD_KEYS.has(key.toLowerCase())) continue;
      if (declaredFields.has(`${resource.id}|${key}`)) continue;
      for (const token of candidateTokens(value)) {
        if (token.length < MIN_TOKEN_LENGTH) continue;
        const claims = index.get(token);
        // Exactly one claimant, or there is no honest way to pick.
        if (claims?.length !== 1) continue;
        const target = claims[0]!;
        if (target.resourceId === resource.id) continue;
        // Cross-account matches need a token that could not plausibly collide;
        // within an account the provider's own namespace already guarantees it.
        if (target.accountId !== resource.accountId && !isStrongToken(token)) continue;
        emit({
          consumerResourceId: resource.id,
          consumerFieldKey: key,
          providerResourceId: target.resourceId,
          // Prefer the external id when the value doubles as one, since that
          // is the identity a reader expects to see named.
          providerOutputKey: target.identityKeys.includes("externalId")
            ? "externalId"
            : (target.identityKeys[0] ?? "externalId"),
          kind: "field-match",
        });
      }
    }
  }

  return { edges, truncated };
}

/**
 * Every token worth prefiltering a *focused* query on — the values that could
 * link this resource to another in either direction, longest first.
 *
 * Both directions come from one function because both are rule-dependent, and
 * splitting them invited the host to ask for half the answer. It covers:
 *
 * - **Identity** — what another resource's field must contain to point here:
 *   the external id, the built-in identity keys, and any key a rule names as
 *   its `targetKey` for this resource's type. Missing that last group is why an
 *   IAM role's dependents were invisible: consumers store a `roleArn`, which is
 *   an identity of the role but not one of the built-in keys.
 * - **Reference** — what this resource points at: its non-descriptive fields,
 *   the fields (or outputs) its own rules name, and the values its
 *   `matchTemplate` rules compose.
 *
 * Comma-joined values contribute their **elements only**. The joined whole can
 * never match an identity, and being the longest string present it would
 * otherwise win the caller's length-ordered budget and crowd out the tokens
 * that do match.
 */
export function focusPrefilterTokens(
  resource: InferenceResource,
  rules: DependencyRuleSet = {},
): string[] {
  const tokens = new Set<string>();
  const extra = extraIdentityKeysFrom(rules);
  const ownRules =
    resource.pluginId && resource.resourceTypeId
      ? (rules[dependencyRuleKey(resource.pluginId, resource.resourceTypeId)] ?? [])
      : [];

  /**
   * `minNumericLength` must mirror whichever pass would consume the token, or
   * the prefilter asks the database for rows no pass can use. An identity or a
   * rule-named field is read with a floor of 1 (a rule may legitimately name a
   * short numeric id); the generic sweep below is read by the guessing pass at
   * the default floor, which is what keeps `port: 5432` and `ttl: 300` out. On
   * a sequential-scan path those would each add a broad, unanchored predicate
   * — `[",:]\s*5432` matches the port field of every Postgres-family resource
   * in the org — and on a sparse resource they survive the length-ordered
   * budget and balloon the candidate set the focused path exists to keep small.
   */
  const add = (value: unknown, minNumericLength?: number) => {
    for (const token of candidateTokens(value, minNumericLength)) {
      // Skip the joined whole; `candidateTokens` returns it alongside the parts.
      if (token.length < MIN_TOKEN_LENGTH || token.includes(",")) continue;
      tokens.add(token);
    }
  };

  if (resource.externalId) add(resource.externalId, 1);
  for (const bag of [resource.fields, resource.outputs]) {
    for (const [key, value] of Object.entries(bag ?? {})) {
      if (isIdentityKey(key.toLowerCase(), resource, extra)) add(value, 1);
    }
  }
  for (const [key, value] of Object.entries(resource.fields ?? {})) {
    // Default numeric floor: matches what the guessing pass will tokenize.
    if (!NON_REFERENCE_FIELD_KEYS.has(key.toLowerCase())) add(value);
  }
  for (const rule of ownRules) {
    const bag = rule.from === "outputs" ? resource.outputs : resource.fields;
    if (rule.matchTemplate) {
      for (const composed of composeMatchValues(rule.matchTemplate, bag)) add(composed, 1);
    } else {
      add(bag?.[rule.fieldKey], 1);
    }
  }

  // Longest first: a uuid or an arn narrows the scan, a three-letter name
  // matches half the org, and callers cap how many they can afford.
  return [...tokens].sort((a, b) => b.length - a.length);
}
