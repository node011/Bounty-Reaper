// Single source of truth for the bundled provider → SDK-factory mapping.
//
// Keyed by the model catalog's `api.npm` package name; each value constructs
// the matching AI-SDK provider instance from a plain options object
// ({ name, apiKey, baseURL, headers, fetch, ... }).
//
// This module is intentionally a LEAF: it imports only the provider factories
// (no Config/Auth/DB/Provider-system deps) so it can be bundled into BOTH the
// main binary (Provider.getSDK) and the standalone hackbrowser worker
// subprocess (hackbrowser-worker.ts) without dragging the whole Provider system
// across the process boundary. The worker previously hand-maintained a
// divergent 3-branch copy of this routing, which silently sent e.g. a Gemini
// key to OpenAI; keeping one shared map prevents that class of drift.

import type { LanguageModelV2, LanguageModelV3 } from "@ai-sdk/provider"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/copilot"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createAlibaba } from "@ai-sdk/alibaba"
import { createVenice } from "venice-ai-sdk-provider"
import { createGitLab } from "@gitlab/gitlab-ai-provider"

// Minimal structural contract a bundled provider factory must satisfy.
// The strict `Provider` type from `ai` would require embedding/image/reranking
// models; we only ever need language-model access (+ optional chat/responses).
export type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3 | LanguageModelV2
  chat?: (modelId: string) => LanguageModelV3 | LanguageModelV2
  responses?: (modelId: string) => LanguageModelV3 | LanguageModelV2
}

export const BUNDLED_PROVIDERS: Record<string, (options: any) => BundledSDK> = {
  "@ai-sdk/amazon-bedrock": createAmazonBedrock,
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/azure": createAzure,
  "@ai-sdk/google": createGoogleGenerativeAI,
  "@ai-sdk/google-vertex": createVertex,
  "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
  "@ai-sdk/openai": createOpenAI,
  "@ai-sdk/openai-compatible": createOpenAICompatible,
  "@openrouter/ai-sdk-provider": createOpenRouter,
  "@ai-sdk/xai": createXai,
  "@ai-sdk/mistral": createMistral,
  "@ai-sdk/groq": createGroq,
  "@ai-sdk/deepinfra": createDeepInfra,
  "@ai-sdk/cerebras": createCerebras,
  "@ai-sdk/cohere": createCohere,
  "@ai-sdk/gateway": createGateway,
  "@ai-sdk/togetherai": createTogetherAI,
  "@ai-sdk/perplexity": createPerplexity,
  "@ai-sdk/vercel": createVercel,
  "@gitlab/gitlab-ai-provider": createGitLab,
  "@ai-sdk/alibaba": createAlibaba,
  "venice-ai-sdk-provider": createVenice,
  // @ts-ignore (TODO: kill this code so we dont have to maintain it)
  "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
}
