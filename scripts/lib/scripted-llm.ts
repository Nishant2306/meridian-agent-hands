import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  RawToolCall,
} from '../../src/agent/llm-client.js';

/**
 * A SCRIPTED FAKE. No API key, no network, no cost.
 *
 * Every PHASE 4 behaviour is exercised through this: conversion, the staleness check, verified
 * completion, the stopping conditions and the distiller. The first real model call happens at
 * GATE 1, and the user makes it.
 *
 * The fake is subject to the SAME boundary as a real model: it is handed the rendered inventory
 * text and nothing else. It cannot see the Observation, so it has to find its marks the way a model
 * does - by reading the list. A fake with privileged access would let a descriptor bug through.
 */
export interface InventoryLine {
  markId: number;
  role: string;
  name: string;
  rest: string;
}

export function parseInventory(text: string): InventoryLine[] {
  const lines: InventoryLine[] = [];

  for (const raw of text.split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (!line.startsWith('[')) continue;

    const close = line.indexOf(']');
    if (close < 0) continue;
    const markId = Number(line.slice(1, close));
    if (!Number.isInteger(markId)) continue;

    const after = line.slice(close + 1).trim();
    const open = after.indexOf('"');
    if (open < 0) continue;
    const shut = after.indexOf('"', open + 1);
    if (shut < 0) continue;

    lines.push({
      markId,
      role: after.slice(0, open).trim(),
      name: after.slice(open + 1, shut),
      rest: after.slice(shut + 1),
    });
  }

  return lines;
}

export interface MarkQuery {
  role?: string;
  name?: string;
  near?: string;
  /** Which match to take when several qualify. Defaults to the first. */
  nth?: number;
}

export function findMark(inventory: string, query: MarkQuery): number {
  const matches = parseInventory(inventory).filter((line) => {
    if (query.role !== undefined && line.role !== query.role) return false;
    if (query.name !== undefined && line.name !== query.name) return false;
    if (query.near !== undefined && !line.rest.includes(query.near)) return false;
    return true;
  });

  const picked = matches[query.nth ?? 0];
  if (picked === undefined) {
    throw new Error(
      'no mark matched ' +
        JSON.stringify(query) +
        ' in inventory:' +
        String.fromCharCode(10) +
        inventory,
    );
  }
  return picked.markId;
}

/** One scripted turn. Receives exactly what the model would have been shown. */
export type ScriptedTurn = (inventory: string, turnIndex: number) => RawToolCall[];

export class ScriptedLlmClient implements LlmClient {
  readonly model = 'scripted-fake-NO-MODEL-WAS-CALLED';
  readonly calls: string[] = [];
  #index = 0;

  constructor(private readonly script: readonly ScriptedTurn[]) {}

  get exhausted(): boolean {
    return this.#index >= this.script.length;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    // The most recent message that actually CARRIES an inventory, not simply the most recent one.
    // A turn that only produced feedback ("noted that effect") adds no marks, and a real model
    // still has the previous inventory in its context window. The fake has to behave the same way
    // or it would be testing a constraint the real client does not have.
    const withInventory = [...request.turns]
      .reverse()
      .find((turn) => turn.role === 'user' && parseInventory(turn.content).length > 0);
    const lastUser =
      withInventory ?? [...request.turns].reverse().find((turn) => turn.role === 'user');
    const inventory = lastUser?.content ?? '';
    this.calls.push(inventory);

    const turn = this.script[this.#index];
    this.#index += 1;

    if (turn === undefined) {
      return Promise.resolve({ text: 'the script is exhausted', toolCalls: [] });
    }
    return Promise.resolve({ text: '', toolCalls: turn(inventory, this.#index - 1) });
  }
}

export const call = (name: string, input: Record<string, unknown>): RawToolCall => ({
  name,
  input,
});
export const param = (name: string) => ({ kind: 'param', name });
