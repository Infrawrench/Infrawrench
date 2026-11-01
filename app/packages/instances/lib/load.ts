import { cache } from "react";
import { specs } from "./attributes";
import { familiesOf, type Family } from "./catalog";
import { decodeAttributes, decodeInstance, type DecodedInstance } from "./decode";
import { loadFxRates } from "./fx";
import { readCatalog, readInstance, readPlatform } from "./kv";
import {
  buildModel,
  latestAttributes,
  relatives,
  type FamilyMember,
  type InstanceModel,
} from "./model";
import { PLATFORMS, platformInfo } from "./platforms";

/**
 * A platform's instance names and newest price list date. From `catalog`, one
 * small value for every platform, when the sync has written it; otherwise
 * from the platform's own state, which also carries a hash per instance.
 */
export const platformNames = cache(
  async (platform: string): Promise<{ names: string[]; asOf: number | null } | null> => {
    const entry = (await readCatalog())?.platforms[platform];
    if (entry) return { names: entry.instances, asOf: entry.asOf };
    const state = await readPlatform(platform);
    return state
      ? { names: Object.keys(state.instances), asOf: state.snapshots.at(-1) ?? null }
      : null;
  },
);

/** Family sizes are read one KV value each; past this many the table shows names only. */
const MAX_FAMILY_READS = 24;

/** One instance, decoded; cached for the request so metadata and the page share it. */
export const loadDecoded = cache(
  async (platform: string, name: string): Promise<DecodedInstance | null> => {
    if (!platformInfo(platform)) return null;
    const file = await readInstance(platform, name);
    return file ? decodeInstance(file) : null;
  },
);

/**
 * EC2's spot prices for one instance type (the spot bundle's instance of the
 * same name) and when they are from. Null when there are none; a failed read is
 * null too, since the page works without them.
 */
export const loadSpot = cache(
  async (name: string): Promise<{ decoded: DecodedInstance; asOf: number } | null> => {
    try {
      const [file, listed] = await Promise.all([readInstance("spot", name), platformNames("spot")]);
      if (!file) return null;
      const decoded = decodeInstance(file);
      return { decoded, asOf: listed?.asOf ?? decoded.onDemand.at(-1)?.at ?? 0 };
    } catch {
      return null;
    }
  },
);

export const loadInstance = cache(
  async (platform: string, name: string): Promise<InstanceModel | null> => {
    const info = platformInfo(platform);
    if (!info) return null;
    const [decoded, listed, fx, spot] = await Promise.all([
      loadDecoded(platform, name),
      platformNames(platform),
      loadFxRates(),
      platform === "ec2" ? loadSpot(name) : null,
    ]);
    if (!decoded) return null;

    const { family: familyNames, related } = relatives(name, listed?.names ?? [name]);
    const self = latestAttributes(decoded.attributes);
    const others =
      familyNames.length <= MAX_FAMILY_READS ? familyNames.filter((n) => n !== name) : [];
    const read = await Promise.all(
      others.map(async (n) => {
        // A sibling that fails to read just shows without its specs.
        const file = await readInstance(platform, n).catch(() => null);
        return [n, file ? latestAttributes(decodeAttributes(file)) : {}] as const;
      }),
    );
    const attributes = new Map<string, Record<string, string>>([[name, self], ...read]);
    const family: FamilyMember[] = familyNames.map((n) => ({
      name: n,
      ...specs(attributes.get(n) ?? {}),
    }));

    return buildModel(decoded, info, {
      asOf: listed?.asOf ?? Math.floor(Date.now() / 1000),
      family,
      related,
      fx,
      spot,
    });
  },
);

/** One service on the index page. */
export interface PlatformSummary {
  platform: string;
  label: string;
  /** A `msg()` source. */
  summary: string;
  instances: number;
  families: number;
}

/** Every service synced so far, in `PLATFORMS` order. */
export const loadIndex = cache(async (): Promise<PlatformSummary[]> => {
  const platforms = Object.keys(PLATFORMS);
  const listed = await Promise.all(platforms.map((p) => platformNames(p)));
  return platforms.flatMap((platform, i) => {
    const names = listed[i]?.names;
    if (!names) return [];
    const info = PLATFORMS[platform]!;
    return [
      {
        platform,
        label: info.label,
        summary: info.summary,
        instances: names.length,
        families: familiesOf(names).length,
      },
    ];
  });
});

/** One service's listing page: every family and every instance in it. */
export interface PlatformListing {
  platform: string;
  label: string;
  summary: string;
  instances: number;
  families: Family[];
}

export const loadListing = cache(async (platform: string): Promise<PlatformListing | null> => {
  const info = platformInfo(platform);
  if (!info) return null;
  const names = (await platformNames(platform))?.names;
  if (!names) return null;
  return {
    platform,
    label: info.label,
    summary: info.summary,
    instances: names.length,
    families: familiesOf(names),
  };
});
