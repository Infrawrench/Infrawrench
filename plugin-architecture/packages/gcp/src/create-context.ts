export interface GcpCreateContext {
  get<T>(url: string): Promise<T>;
  paginate<T>(baseUrl: string, key: string, params?: Record<string, string>): Promise<T[]>;
  token(): Promise<string>;
  project: string;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  machineTypeSpecCache: Map<string, { guestCpus: number; memoryMb: number }>;
}
