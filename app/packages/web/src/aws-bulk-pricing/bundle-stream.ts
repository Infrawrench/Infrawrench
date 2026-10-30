/**
 * Reads a bundle's JSON a piece at a time. An EC2 bundle is over 200 MB of
 * JSON, more than a Worker's 128 MB, but it is a few small tables followed by
 * `instances`, an object of independent rows (the largest under 1 MB). So
 * this scans the bytes for value boundaries and parses one value at a time:
 * each top-level table as a whole, then each instance on its own.
 *
 * Only `"` and `\` matter inside a string and neither byte occurs within a
 * multi-byte UTF-8 sequence, so the scan works on raw bytes.
 */

export type BundleEvent =
  | { kind: "table"; key: string; value: unknown }
  | { kind: "instance"; name: string; value: unknown };

const enum State {
  Open, // expecting the `{` of an object
  KeyOrEnd, // expecting a key or `}`
  Key, // inside a key's string
  Colon,
  ValueStart,
  Value, // inside a value
  CommaOrEnd,
  Done,
}

const enum Kind {
  Nested,
  String,
  Scalar,
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
}

export async function* scanBundle(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<BundleEvent> {
  const scanner = new Scanner();
  for await (const chunk of chunks) {
    yield* scanner.push(chunk);
  }
  scanner.finish();
}

class Scanner {
  private state = State.Open;
  /** True once inside `instances`, whose keys are instance names. */
  private inInstances = false;
  private key = "";
  private kind = Kind.Nested;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): BundleEvent[] {
    const events: BundleEvent[] = [];
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      switch (this.state) {
        case State.Value: {
          // The hot loop: everything but the tables is in here.
          const start = i;
          let end = -1;
          if (this.kind === Kind.Nested) {
            for (; i < n; i++) {
              const b = chunk[i]!;
              if (this.inString) {
                if (this.escaped) this.escaped = false;
                else if (b === BACKSLASH) this.escaped = true;
                else if (b === QUOTE) this.inString = false;
              } else if (b === QUOTE) {
                this.inString = true;
              } else if (b === OPEN_BRACKET || b === OPEN_BRACE) {
                this.depth++;
              } else if (b === CLOSE_BRACKET || b === CLOSE_BRACE) {
                if (--this.depth === 0) {
                  end = ++i;
                  break;
                }
              }
            }
          } else if (this.kind === Kind.String) {
            for (; i < n; i++) {
              const b = chunk[i]!;
              if (this.escaped) this.escaped = false;
              else if (b === BACKSLASH) this.escaped = true;
              else if (b === QUOTE) {
                end = ++i;
                break;
              }
            }
          } else {
            for (; i < n; i++) {
              const b = chunk[i]!;
              if (b === COMMA || b === CLOSE_BRACE || b === CLOSE_BRACKET || isSpace(b)) {
                end = i;
                break;
              }
            }
          }
          this.append(chunk, start, end === -1 ? n : end);
          if (end !== -1) {
            events.push(this.complete());
            this.state = State.CommaOrEnd;
          }
          break;
        }
        case State.Key: {
          const start = i;
          let end = -1;
          for (; i < n; i++) {
            const b = chunk[i]!;
            if (this.escaped) this.escaped = false;
            else if (b === BACKSLASH) this.escaped = true;
            else if (b === QUOTE) {
              end = i++;
              break;
            }
          }
          this.append(chunk, start, end === -1 ? n : end);
          if (end !== -1) {
            this.key = JSON.parse(`"${this.text()}"`) as string;
            this.len = 0;
            this.state = State.Colon;
          }
          break;
        }
        default: {
          const b = chunk[i++]!;
          if (!isSpace(b)) this.structural(b);
        }
      }
    }
    return events;
  }

  finish(): void {
    if (this.state !== State.Done) throw new Error("bundle ended before its closing brace");
  }

  private structural(b: number): void {
    switch (this.state) {
      case State.Open:
        if (b !== OPEN_BRACE) throw this.unexpected(b);
        this.state = State.KeyOrEnd;
        return;
      case State.KeyOrEnd:
        if (b === QUOTE) {
          this.state = State.Key;
          this.escaped = false;
        } else if (b === CLOSE_BRACE) {
          this.closeObject();
        } else {
          throw this.unexpected(b);
        }
        return;
      case State.Colon:
        if (b !== COLON) throw this.unexpected(b);
        if (!this.inInstances && this.key === "instances") {
          this.inInstances = true;
          this.state = State.Open;
        } else {
          this.state = State.ValueStart;
        }
        return;
      case State.ValueStart:
        this.len = 0;
        this.escaped = false;
        this.inString = false;
        if (b === OPEN_BRACE || b === OPEN_BRACKET) {
          this.kind = Kind.Nested;
          this.depth = 1;
        } else if (b === QUOTE) {
          this.kind = Kind.String;
        } else {
          this.kind = Kind.Scalar;
        }
        this.append(Uint8Array.of(b), 0, 1);
        this.state = State.Value;
        return;
      case State.CommaOrEnd:
        if (b === COMMA) this.state = State.KeyOrEnd;
        else if (b === CLOSE_BRACE) this.closeObject();
        else throw this.unexpected(b);
        return;
      case State.Done:
        throw this.unexpected(b);
      default:
        throw new Error(`bundle scanner reached state ${this.state} outside its loop`);
    }
  }

  private closeObject(): void {
    if (this.inInstances) {
      this.inInstances = false;
      this.state = State.CommaOrEnd;
    } else {
      this.state = State.Done;
    }
  }

  private complete(): BundleEvent {
    const value: unknown = JSON.parse(this.text());
    this.len = 0;
    // A scalar ends on the byte after it, which has not been consumed; it is
    // whitespace, `,` or `}` and CommaOrEnd handles all three.
    return this.inInstances
      ? { kind: "instance", name: this.key, value }
      : { kind: "table", key: this.key, value };
  }

  private text(): string {
    return this.decoder.decode(this.buf.subarray(0, this.len));
  }

  private append(chunk: Uint8Array, start: number, end: number): void {
    const add = end - start;
    if (add <= 0) return;
    if (this.len + add > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.len + add) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(chunk.subarray(start, end), this.len);
    this.len += add;
  }

  private unexpected(b: number): Error {
    return new Error(`unexpected ${JSON.stringify(String.fromCharCode(b))} in bundle`);
  }
}
