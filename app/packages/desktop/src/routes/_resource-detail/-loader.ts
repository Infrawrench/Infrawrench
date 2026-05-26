// Barrel re-export. The three loaders and the shared types/interfaces live
// in `./-loaders/` — split out so this file isn't a 1k-line godfile. The
// public surface is unchanged; the route panel imports from here.

export { loadCloudResource } from "./-loaders/cloud";
export { loadLocalPeerResource } from "./-loaders/local-peer";
export { loadLocalResource } from "./-loaders/local";
export type { LoaderParams, LoaderRefs, LoaderSetters } from "./-loaders/types";
