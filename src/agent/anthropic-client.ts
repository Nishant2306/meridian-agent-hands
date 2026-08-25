import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LlmClient, LlmRequest, LlmResponse, RawToolCall } from './llm-client.js';
import { TOOL_ARGS, TOOL_NAMES } from './tools.js';

/**
 * The real client. NOTHING IN THE TEST SUITE CONSTRUCTS THIS.
 *
 * Every behaviour in PHASE 4 - conversion, staleness rejection, verified completion, the stopping
 * conditions, the distiller - is exercised with a scripted fake client and no API key. This file
 * exists so that the CLI has something to run at GATE 1, and so the tool schemas the model actually
 * sees are generated from the SAME zod definitions the loop validates against. Two hand-maintained
 * copies of a tool schema drift, and the drift shows up as the model calling a tool with arguments
 * the loop then rejects.
 */
const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  observe_more: 'Re-read the screen. Use this when the inventory looks stale or incomplete.',
  click: 'Click the control with this markId.',
  type_text: 'Type a value into the control with this markId.',
  select_option: 'Choose an option in the control with this markId.',
  read_value:
    'Read the value displayed by the control with this markId, and bind it to a declared output.',
  propose_effect:
    'State what should now be observably different after your last action. The system verifies it.',
  propose_state_reached: 'Give a short label to the place you believe you have reached.',
  propose_record_identity:
    'Point at the control that displays the identity of the record you were asked to operate on.',
  propose_goal_reached:
    'Propose that the goal is met. This does NOT end the run: the system re-observes and decides.',
  request_human: 'Hand over to a person, because something you do not recognise is in the way.',
  give_up: 'Stop, because you cannot see a way forward.',
};

export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  readonly #client: Anthropic;
  readonly #maxTokens: number;

  constructor(options: { apiKey: string; model: string; maxTokens?: number }) {
    this.model = options.model;
    this.#client = new Anthropic({ apiKey: options.apiKey });
    this.#maxTokens = options.maxTokens ?? 2048;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const tools = TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name] ?? name,
      input_schema: z.toJSONSchema(TOOL_ARGS[name]) as Anthropic.Tool['input_schema'],
    }));

    const messages: Anthropic.MessageParam[] = request.turns.map((turn) => ({
      role: turn.role,
      content: turn.content === '' ? '(no text)' : turn.content,
    }));

    const response = await this.#client.messages.create({
      model: this.model,
      max_tokens: this.#maxTokens,
      system: request.system,
      tools,
      messages,
    });

    const toolCalls: RawToolCall[] = [];
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') toolCalls.push({ name: block.name, input: block.input });
    }

    return { text, toolCalls };
  }
}
