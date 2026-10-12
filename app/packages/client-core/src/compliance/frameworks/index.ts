/**
 * The framework registry. Another framework is one more file beside these,
 * plus one entry in {@link COMPLIANCE_FRAMEWORKS}; the status computation,
 * the API, the evidence pack and every UI read the list.
 */
import { ISO27001_FRAMEWORK } from "./iso27001";
import { SOC2_FRAMEWORK } from "./soc2";
import type { ComplianceFrameworkDefinition } from "./types";

export type { ComplianceControlDefinition, ComplianceFrameworkDefinition } from "./types";
export { ISO27001_FRAMEWORK, SOC2_FRAMEWORK };

export const COMPLIANCE_FRAMEWORKS: readonly ComplianceFrameworkDefinition[] = [
  SOC2_FRAMEWORK,
  ISO27001_FRAMEWORK,
];

export function getComplianceFramework(id: string): ComplianceFrameworkDefinition | undefined {
  return COMPLIANCE_FRAMEWORKS.find((f) => f.id === id);
}
