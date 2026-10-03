/**
 * Resource ids are `<accountId>:<typeId>:<externalId>`, built by each plugin
 * from the account it was called with. Plugins act on the external id alone
 * and run against the caller's own account, so a caller who sends an id with
 * another account's prefix still gets a successful provider call back. Every
 * place that then keys a database read or write on that id (resource rows,
 * stored secrets) has to check the prefix first, or a provider call against
 * one account turns into a read from, or a write to, another org's row.
 */
export function resourceIdBelongsToAccount(resourceId: string, accountId: string): boolean {
  return accountId.length > 0 && resourceId.startsWith(`${accountId}:`);
}
