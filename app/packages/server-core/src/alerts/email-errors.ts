/**
 * The error a write path throws when an alert email recipient list fails
 * validation. A database-free leaf so callers that only need to recognise it
 * (route handlers, MCP tools) do not import the database client with it.
 */
export class AlertEmailRecipientsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertEmailRecipientsError";
  }
}
