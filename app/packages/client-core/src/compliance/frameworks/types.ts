import type { EvidenceSourceId } from "../sources";

/**
 * One control in a framework, mapped onto the evidence sources that speak to
 * it. `title` is a short paraphrase written for this product, never the
 * framework's own control text (that text is copyrighted, and an auditor
 * reads the id against their own copy anyway).
 */
export interface ComplianceControlDefinition {
  /** The framework's own identifier, e.g. `CC6.1` or `8.8`. */
  id: string;
  /** Short paraphrase of what the control is about. */
  title: string;
  /** The family or theme the control sits in, for grouping on screen and in the PDF. */
  group: string;
  /** Ordered: the first source is the primary evidence. Never empty. */
  sources: EvidenceSourceId[];
}

export interface ComplianceFrameworkDefinition {
  /** Stable, URL-safe id: `soc2`, `iso27001`. */
  id: string;
  name: string;
  /** Which edition the control ids refer to. */
  version: string;
  description: string;
  /**
   * Printed on the status screen and the PDF: this registry covers the
   * controls Infrawrench holds evidence for, not the whole framework.
   */
  scopeNote: string;
  controls: ComplianceControlDefinition[];
}
