/**
 * Minimal server-sent-events parser over a web-standard ReadableStream.
 * Yields the JSON-parsed `data:` payload of each event. Works with native
 * fetch on web/desktop and `expo/fetch` on React Native.
 */
export async function* parseSseStream<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; support \n\n and \r\n\r\n.
      for (;;) {
        const sep = buffer.search(/\r?\n\r?\n/);
        if (sep === -1) break;
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as T;
        } catch {
          // Ignore non-JSON keep-alives.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse an NDJSON stream (one JSON object per line). */
export async function* parseNdjsonStream<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as T;
        } catch {
          // Skip malformed lines.
        }
      }
    }
    const rest = buffer.trim();
    if (rest) {
      try {
        yield JSON.parse(rest) as T;
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock();
  }
}
