/**
 * Aggregate re-export of marketing-site content data.
 *
 * The original `content.ts` lumped three unrelated data arrays into one file
 * (`featureSections`, `providerGroups`, `typewriterStrings`). Each consumer
 * pulls only one of them, so the data lives in its own focused module and is
 * re-exported here for any callers that prefer the legacy import path.
 */
export { featureSections } from "./feature-sections";
export { providerGroups } from "./provider-groups";
export { typewriterStrings } from "./typewriter-strings";
