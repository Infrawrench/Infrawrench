/**
 * Structural link between two resource instances.
 * Records topology (this resource is linked to that one).
 * The SecretFieldState records HOW to resolve the value.
 */
export interface Association {
  id: string;
  /** The resource that consumes the association (e.g. K8s cluster) */
  consumerPluginId: string;
  consumerResourceTypeId: string;
  consumerResourceId: string;
  /** Which field on the consumer is resolved via this association */
  consumerFieldKey: string;
  /** The resource that provides the output (e.g. DOKS cluster) */
  providerPluginId: string;
  providerResourceTypeId: string;
  providerResourceId: string;
  /** Which output on the provider is used */
  providerOutputKey: string;
  createdAt: string;
  updatedAt: string;
}
