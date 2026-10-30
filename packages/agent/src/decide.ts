/** a decision model: typed questions about a piece of state, answered with probabilities instead of text (Vercel AI
 *  Gateway's `/v1/evaluate`, TypeSafe AI's Jev by default). A run asks one where it must sort what the user said into a
 *  route; no answer (no decider, the service down or slow) is the caller's to take as the careful route */
export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'boolean'; instructions: string; criteria?: { true: string; false: string } };
export type Answer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
  | { type: 'boolean'; probability: number };

export interface Decider {
  /** every question answered against the same state, in one round trip; undefined when no answer came for all of them */
  ask(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer> | undefined>;
}

/** the option `criteria` names that fits `state` best, and how sure it is (0–1); undefined when none came */
export async function choose(d: Decider | undefined, state: unknown, instructions: string, criteria: Record<string, string>, signal?: AbortSignal): Promise<{ choice: string; p: number } | undefined> {
  const a = (await d?.ask(state, { q: { type: 'choice', instructions, criteria } }, signal))?.q;
  if (a?.type !== 'choice' || !(a.choice in criteria)) return undefined;
  return { choice: a.choice, p: a.probabilities?.[a.choice] ?? 0 };
}

/** the AI Gateway's decision endpoint (or the host's gateway in front of it). Pinned to a release of Jev, so a new one
 *  can't change a route under a running film */
export function gatewayDecider(key: string, o: { baseUrl?: string; model?: string; timeoutMs?: number } = {}): Decider {
  const base = (o.baseUrl || 'https://ai-gateway.vercel.sh').replace(/\/+$/, '').replace(/\/v1$/, '');
  const model = o.model || 'typesafe-ai/jev-1.14.0';
  return {
    async ask(state, questions, signal) {
      // a route is worth a moment, never a wait: ~0.1 s answered, 4 s at most
      const timeout = AbortSignal.timeout(o.timeoutMs ?? 4000);
      try {
        const res = await fetch(`${base}/v1/evaluate`, {
          method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          body: JSON.stringify({ model, state, questions }),
        });
        if (!res.ok) { console.warn(`[decide] ${res.status}: ${(await res.text()).slice(0, 200)}`); return undefined; }
        const answers = ((await res.json()) as { answers?: Record<string, Answer> }).answers;
        return answers && Object.keys(questions).every((k) => answers[k]?.type === questions[k].type) ? answers : undefined;
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn(`[decide] no answer: ${(e as Error).message}`);
        return undefined;
      }
    },
  };
}
