function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error ?? "Unknown error");
}

function tryParseJsonPayload(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep trying other shapes.
    }
  }
  return null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatGoogleApiError(errorRecord: Record<string, unknown>): string | null {
  const topLevelError = getRecord(errorRecord.error) ?? errorRecord;
  const message = getString(topLevelError.message);
  const details = Array.isArray(topLevelError.details) ? topLevelError.details : [];

  for (const detail of details) {
    const detailRecord = getRecord(detail);
    if (!detailRecord) continue;
    const metadata = getRecord(detailRecord.metadata) ?? {};
    const reason = getString(detailRecord.reason);

    if (reason === "SERVICE_DISABLED") {
      const serviceTitle = getString(metadata.serviceTitle) ?? "This Google Cloud API";
      const project =
        getString(metadata.containerInfo)
        ?? getString(metadata.consumer)?.replace(/^projects\//, "")
        ?? "this project";
      const activationUrl = getString(metadata.activationUrl);
      return activationUrl
        ? `${serviceTitle} is not enabled for project ${project}. Enable it in Google Cloud Console, then retry in a few minutes.\n${activationUrl}`
        : `${serviceTitle} is not enabled for project ${project}. Enable it in Google Cloud Console, then retry in a few minutes.`;
    }
  }

  if ((getString(topLevelError.status) === "PERMISSION_DENIED" || details.length > 0) && message) {
    return `Permission denied. ${message}`;
  }

  return message;
}

export function formatErrorMessage(error: unknown): string {
  const raw = rawErrorMessage(error).replace(/^Error:\s*/, "").trim();
  const parsed = tryParseJsonPayload(raw);
  const parsedRecord = getRecord(parsed);

  if (parsedRecord) {
    const googleApiMessage = formatGoogleApiError(parsedRecord);
    if (googleApiMessage) return googleApiMessage;

    const nestedError = getRecord(parsedRecord.error);
    const nestedMessage = getString(nestedError?.message);
    if (nestedMessage) return nestedMessage;

    const topLevelMessage = getString(parsedRecord.message);
    if (topLevelMessage) return topLevelMessage;
  }

  const normalized = raw.replace(/\s+/g, " ").trim();
  const lowered = normalized.toLowerCase();

  if (lowered.includes("econnrefused") || lowered.includes("connection refused")) {
    return "Connection refused. Check the host, port, and that the service is reachable.";
  }
  if (lowered.includes("enotfound") || lowered.includes("getaddrinfo")) {
    return "Host not found. Check the hostname or DNS settings.";
  }
  if (lowered.includes("timed out") || lowered.includes("etimedout") || lowered.includes("timeout")) {
    return "Connection timed out. Check network access, firewall rules, and the remote service.";
  }
  if (
    lowered.includes("unauthorized")
    || lowered.includes("invalid credentials")
    || lowered.includes("authentication failed")
    || lowered.includes("permission denied")
  ) {
    return `Authentication or permission error. ${normalized}`;
  }

  return normalized;
}
