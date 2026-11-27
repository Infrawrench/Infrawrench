import { hashObjectSync } from "./object/hash";
import type { GitObject, ObjectId, ObjectReader, ObjectType } from "./types";

/**
 * An object database in a Map. It is what the other git packages test
 * against, and what a small operation builds its new objects in before
 * they are written out as a pack.
 */
export class MemoryObjectStore implements ObjectReader {
  private readonly objects = new Map<ObjectId, GitObject>();

  get size(): number {
    return this.objects.size;
  }

  async read(oid: ObjectId): Promise<GitObject | null> {
    return this.objects.get(oid) ?? null;
  }

  async has(oid: ObjectId): Promise<boolean> {
    return this.objects.has(oid);
  }

  /** Stores an object and returns its id. */
  write(type: ObjectType, data: Uint8Array): ObjectId {
    const oid = hashObjectSync(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Stores an object under an id the caller already computed. */
  set(oid: ObjectId, object: GitObject): void {
    this.objects.set(oid, object);
  }

  get(oid: ObjectId): GitObject | undefined {
    return this.objects.get(oid);
  }

  entries(): IterableIterator<[ObjectId, GitObject]> {
    return this.objects.entries();
  }
}
