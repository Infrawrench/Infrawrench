/**
 * A repository's tree at a ref, as Terraform root discovery reads it
 * (`@infrawrench/git-terraform` `TreeReader`), over the storage's reader.
 * A path the commit does not have is an empty directory or no file; only the
 * storage not answering is an error.
 */
import type { TreeReader } from "@infrawrench/git-terraform";
import { type RepoReader, RepoReaderError } from "../repo/reader";

export const treeReaderOf = (reader: RepoReader, ref: string): TreeReader => ({
  list: async (path) => {
    try {
      const listing = await reader.tree({ ref, path, lastCommits: false });
      return listing.entries.map((entry) => ({
        name: entry.name,
        kind: entry.type === "tree" ? ("directory" as const) : ("file" as const),
      }));
    } catch (error) {
      if (error instanceof RepoReaderError && error.code !== "unavailable") return [];
      throw error;
    }
  },
  read: async (path) => {
    try {
      const blob = await reader.blob({ ref, path });
      return blob.text === null ? null : new TextEncoder().encode(blob.text);
    } catch (error) {
      if (error instanceof RepoReaderError && error.code !== "unavailable") return null;
      throw error;
    }
  },
});
