/**
 * Voyage AI publishes no model-listing endpoint, so the catalogue comes from
 * the docs (docs.voyageai.com/docs/embeddings, /contextualized-chunk-embeddings,
 * /multimodal-embeddings, /reranker and /pricing), read October 2026.
 * Deprecated models are left out. Prices are USD per million tokens.
 */
export type VoyageKind = "embedding" | "contextualized" | "multimodal" | "rerank";

export interface VoyageModel {
  id: string;
  kind: VoyageKind;
  contextLength?: number;
  dimensions?: string;
  pricePerMillion: number;
  generation: "current" | "previous";
  description: string;
}

export const VOYAGE_MODELS: VoyageModel[] = [
  {
    id: "voyage-4-large",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.12,
    generation: "current",
    description: "Best general-purpose and multilingual retrieval quality",
  },
  {
    id: "voyage-4",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.06,
    generation: "current",
    description: "General-purpose and multilingual retrieval",
  },
  {
    id: "voyage-4-lite",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.02,
    generation: "current",
    description: "Optimized for latency and cost",
  },
  {
    id: "voyage-code-4",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.12,
    generation: "current",
    description: "Code retrieval and coding agents",
  },
  {
    id: "voyage-finance-2",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024",
    pricePerMillion: 0.12,
    generation: "current",
    description: "Finance retrieval and RAG",
  },
  {
    id: "voyage-law-2",
    kind: "embedding",
    contextLength: 16000,
    dimensions: "1024",
    pricePerMillion: 0.12,
    generation: "current",
    description: "Legal retrieval and RAG",
  },
  {
    id: "voyage-3-large",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.18,
    generation: "previous",
    description: "Previous-generation general-purpose embeddings",
  },
  {
    id: "voyage-3.5",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.06,
    generation: "previous",
    description: "Previous-generation general-purpose embeddings",
  },
  {
    id: "voyage-3.5-lite",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.02,
    generation: "previous",
    description: "Previous generation, optimized for latency and cost",
  },
  {
    id: "voyage-3",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024",
    pricePerMillion: 0.06,
    generation: "previous",
    description: "General-purpose and multilingual retrieval",
  },
  {
    id: "voyage-3-lite",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "512",
    pricePerMillion: 0.02,
    generation: "previous",
    description: "Optimized for latency and cost",
  },
  {
    id: "voyage-code-3",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.18,
    generation: "previous",
    description: "Code retrieval",
  },
  {
    id: "voyage-multilingual-2",
    kind: "embedding",
    contextLength: 32000,
    dimensions: "1024",
    pricePerMillion: 0.12,
    generation: "previous",
    description: "Multilingual retrieval and RAG",
  },
  {
    id: "voyage-context-4",
    kind: "contextualized",
    contextLength: 120000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.12,
    generation: "current",
    description: "Contextualized chunk embeddings",
  },
  {
    id: "voyage-context-3",
    kind: "contextualized",
    contextLength: 120000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.18,
    generation: "previous",
    description: "Previous-generation contextualized chunk embeddings",
  },
  {
    id: "voyage-multimodal-3.5",
    kind: "multimodal",
    contextLength: 32000,
    dimensions: "1024 (default), 256, 512, 2048",
    pricePerMillion: 0.12,
    generation: "current",
    description: "Interleaved text, images and video frames",
  },
  {
    id: "voyage-multimodal-3",
    kind: "multimodal",
    contextLength: 32000,
    dimensions: "1024",
    pricePerMillion: 0.12,
    generation: "previous",
    description: "Interleaved text and images",
  },
  {
    id: "rerank-3",
    kind: "rerank",
    contextLength: 32000,
    pricePerMillion: 0.05,
    generation: "current",
    description: "Reranker optimized for quality",
  },
  {
    id: "rerank-3-lite",
    kind: "rerank",
    contextLength: 32000,
    pricePerMillion: 0.02,
    generation: "current",
    description: "Reranker optimized for latency",
  },
  {
    id: "rerank-2.5",
    kind: "rerank",
    contextLength: 32000,
    pricePerMillion: 0.05,
    generation: "previous",
    description: "Instruction-following multilingual reranker",
  },
  {
    id: "rerank-2.5-lite",
    kind: "rerank",
    contextLength: 32000,
    pricePerMillion: 0.02,
    generation: "previous",
    description: "Instruction-following reranker, latency-optimized",
  },
  {
    id: "rerank-2",
    kind: "rerank",
    contextLength: 16000,
    pricePerMillion: 0.05,
    generation: "previous",
    description: "Second-generation multilingual reranker",
  },
  {
    id: "rerank-2-lite",
    kind: "rerank",
    contextLength: 8000,
    pricePerMillion: 0.02,
    generation: "previous",
    description: "Second-generation reranker, latency-optimized",
  },
];

/** Batch endpoints accepted by `POST /v1/batches`, and the model kind each takes. */
export const BATCH_ENDPOINTS: Array<{ id: string; label: string; kind: VoyageKind }> = [
  { id: "/v1/embeddings", label: "Text embeddings", kind: "embedding" },
  {
    id: "/v1/contextualizedembeddings",
    label: "Contextualized chunk embeddings",
    kind: "contextualized",
  },
  { id: "/v1/rerank", label: "Rerank", kind: "rerank" },
];
