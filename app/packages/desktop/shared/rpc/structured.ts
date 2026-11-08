/**
 * A value of no fixed shape, carried across Effect RPC the way Electron's IPC
 * used to carry it: by structured clone, not by `JSON.stringify`.
 *
 * Most operations have a schema for every field. A few carry values only the
 * far side understands: a database row from a plugin's SQL driver, a Docker
 * or Kubernetes driver's answer, a workflow host call's arguments and result.
 * `Schema.Unknown` would encode those as JSON and fail on anything JSON lacks
 * (a `Date` column, a `bytea` Buffer, a `bigint`, an `undefined` argument in
 * the middle of a positional list), which `ipcRenderer.invoke` delivered
 * intact. {@link StructuredValue} encodes the same set structured clone
 * preserves into plain JSON and back:
 *
 * - `undefined` (also in arrays and as an object property), `NaN`,
 *   `Infinity`, `-Infinity`, `bigint`;
 * - `Date`, `Map`, `Set`, `Error` (`name`, `message`, `stack`);
 * - `Uint8Array`, Node's `Buffer` and other typed-array views, which decode
 *   as a `Uint8Array` (a `Buffer` arrived as one under structured clone too);
 * - any other object as its own enumerable properties, the way structured
 *   clone copies a class instance. Functions and symbols are dropped, where
 *   structured clone would have thrown.
 *
 * A special value is an object with an `$iw` tag; a plain object that has an
 * `$iw` key of its own is wrapped so it cannot be mistaken for one. A cycle
 * fails the encode (structured clone allowed it; nothing sent here has one).
 */
import { Predicate, Schema, SchemaTransformation } from "effect";
import { Base64 } from "effect/encoding";

const TAG = "$iw";

type Json = Schema.Json;

function tagged(tag: string, value?: Json): Json {
  return value === undefined ? { [TAG]: tag } : { [TAG]: tag, v: value };
}

function encodeNumber(value: number): Json {
  if (Number.isFinite(value)) return value;
  return tagged("n", Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity");
}

function encodeObject(value: object, seen: Set<object>): Json {
  if (seen.has(value)) throw new Error("StructuredValue: cannot encode a cyclic value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item: unknown) => flatten(item, seen));
    if (Predicate.isDate(value)) return tagged("d", encodeNumber(value.getTime()));
    if (Predicate.isUint8Array(value)) return tagged("x", Base64.encode(value));
    if (ArrayBuffer.isView(value)) {
      return tagged(
        "x",
        Base64.encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      );
    }
    if (value instanceof ArrayBuffer) return tagged("x", Base64.encode(new Uint8Array(value)));
    if (Predicate.isMap(value)) {
      return tagged(
        "m",
        [...value.entries()].map(([k, v]): Json => [flatten(k, seen), flatten(v, seen)]),
      );
    }
    if (Predicate.isSet(value)) {
      return tagged(
        "s",
        [...value.values()].map((item) => flatten(item, seen)),
      );
    }
    if (Predicate.isError(value)) {
      return tagged("e", {
        name: value.name,
        message: value.message,
        ...(Predicate.isString(value.stack) ? { stack: value.stack } : {}),
      });
    }
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      if (Predicate.isFunction(item) || Predicate.isSymbol(item)) continue;
      out[key] = flatten(item, seen);
    }
    return Object.hasOwn(out, TAG) ? tagged("o", out) : out;
  } finally {
    seen.delete(value);
  }
}

function flatten(value: unknown, seen: Set<object>): Json {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value;
  if (Predicate.isUndefined(value)) return tagged("u");
  if (Predicate.isNumber(value)) return encodeNumber(value);
  if (Predicate.isBigInt(value)) return tagged("b", value.toString());
  if (Predicate.isFunction(value) || Predicate.isSymbol(value)) return tagged("u");
  if (Predicate.isObjectOrArray(value)) return encodeObject(value, seen);
  return tagged("u");
}

function reviveNumber(value: unknown): number {
  if (Predicate.isNumber(value)) return value;
  if (value === "Infinity") return Infinity;
  if (value === "-Infinity") return -Infinity;
  return NaN;
}

function reviveBytes(value: unknown): Uint8Array {
  if (!Predicate.isString(value)) return new Uint8Array();
  const decoded = Base64.decode(value);
  return decoded._tag === "Success" ? decoded.success : new Uint8Array();
}

function reviveError(value: unknown): Error {
  const message =
    Predicate.hasProperty(value, "message") && Predicate.isString(value.message)
      ? value.message
      : "";
  const error = new Error(message);
  if (Predicate.hasProperty(value, "name") && Predicate.isString(value.name)) {
    error.name = value.name;
  }
  if (Predicate.hasProperty(value, "stack") && Predicate.isString(value.stack)) {
    error.stack = value.stack;
  }
  return error;
}

function reviveTagged(tag: unknown, value: unknown): unknown {
  switch (tag) {
    case "u":
      return undefined;
    case "n":
      return reviveNumber(value);
    case "b":
      return Predicate.isString(value) ? BigInt(value) : undefined;
    case "d":
      return new Date(reviveNumber(value));
    case "x":
      return reviveBytes(value);
    case "m":
      return new Map(
        Array.isArray(value)
          ? value.map((entry: unknown): [unknown, unknown] =>
              Array.isArray(entry) ? [revive(entry[0]), revive(entry[1])] : [undefined, undefined],
            )
          : [],
      );
    case "s":
      return new Set(Array.isArray(value) ? value.map(revive) : []);
    case "e":
      return reviveError(value);
    case "o":
      return reviveRecord(value);
    default:
      return undefined;
  }
}

function reviveRecord(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Predicate.isObject(value)) return out;
  for (const [key, item] of Object.entries(value)) out[key] = revive(item);
  return out;
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (!Predicate.isObject(value)) return value;
  if (Predicate.hasProperty(value, TAG)) {
    return reviveTagged(value[TAG], Predicate.hasProperty(value, "v") ? value.v : undefined);
  }
  return reviveRecord(value);
}

/** Any value structured clone could carry; JSON on the wire. */
export const StructuredValue = Schema.Json.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform<unknown, Json>({
      decode: revive,
      encode: (value) => flatten(value, new Set()),
    }),
  ),
);

/** Positional arguments, `undefined` holes included. */
export const StructuredArgs = Schema.Array(StructuredValue);
