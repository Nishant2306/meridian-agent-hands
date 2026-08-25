/**
 * The seam between the discovery loop and a model.
 *
 * It is deliberately tiny, and it is the ONLY place in this project that a language model is
 * reachable from. Two consequences fall out of that:
 *
 *   - the whole loop can be driven by a scripted fake client, so every behaviour in PHASE 4 is
 *     tested without an API key and without spending anything
 *   - `ReplayEngine` (PHASE 5) has no constructor parameter of this type, so there is nothing to
 *     inject even if somebody wanted to. "Replay makes zero LLM calls" is a shape, not a promise
 */
export interface RawToolCall {
  name: string;
  input: unknown;
}

export interface LlmTurn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: readonly RawToolCall[];
}

export interface LlmRequest {
  system: string;
  turns: readonly LlmTurn[];
}

export interface LlmResponse {
  text: string;
  toolCalls: readonly RawToolCall[];
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
