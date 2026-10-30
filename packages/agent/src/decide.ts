/** a decision model: typed questions about a piece of state, answered with probabilities instead of text (Vercel AI
 *  Gateway's `/v1/evaluate`, TypeSafe AI's Jev by default). A run asks one where it must sort what the user said into a
 *  route; no answer (no decider, the service down or slow) is the caller's to take as the careful route */
export interface Decider {
  /** the option `criteria` names that fits `state` best, and how sure it is (0–1); undefined when none came */
  choose(state: unknown, instructions: string, criteria: Record<string, string>, signal?: AbortSignal): Promise<{ choice: string; p: number } | undefined>;
}

/** the AI Gateway's decision endpoint (or the host's gateway in front of it). Pinned to a release of Jev, so a new one
 *  can't change a route under a running film */
export function gatewayDecider(key: string, o: { baseUrl?: string; model?: string; timeoutMs?: number } = {}): Decider {
  const base = (o.baseUrl || 'https://ai-gateway.vercel.sh').replace(/\/+$/, '').replace(/\/v1$/, '');
  const model = o.model || 'typesafe-ai/jev-1.14.0';
  return {
    async choose(state, instructions, criteria, signal) {
      // a route is worth a moment, never a wait: ~0.1 s answered, 4 s at most
      const timeout = AbortSignal.timeout(o.timeoutMs ?? 4000);
      try {
        const res = await fetch(`${base}/v1/evaluate`, {
          method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          body: JSON.stringify({ model, state, questions: { q: { type: 'choice', instructions, criteria } } }),
        });
        if (!res.ok) { console.warn(`[decide] ${res.status}: ${(await res.text()).slice(0, 200)}`); return undefined; }
        const a = ((await res.json()) as { answers?: { q?: { choice?: unknown; probabilities?: Record<string, number> } } }).answers?.q;
        if (typeof a?.choice !== 'string' || !(a.choice in criteria)) return undefined;
        return { choice: a.choice, p: a.probabilities?.[a.choice] ?? 0 };
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn(`[decide] no answer: ${(e as Error).message}`);
        return undefined;
      }
    },
  };
}
