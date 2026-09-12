export interface Ask {
  ask_id: string;
  question: string;
  context?: string;
}

export interface AskHandle {
  /** Passed to RpcClient as a custom tool. Shaped for RpcClientCustomTool. */
  tool: unknown;
  /** Resolve a parked question. False when no ask by that id is waiting. */
  answer(askId: string, text: string): boolean;
  /** The question currently parked, or null. */
  pending(): Ask | null;
  /** Reject everything still parked — used when a run is torn down. */
  cancelAll(reason: string): void;
}

/**
 * The tool a dispatched agent calls when it is stuck.
 *
 * The mechanism is the whole trick: `execute` returns a promise, and this
 * simply does not resolve it until an answer arrives. omp's turn parks on the
 * tool call, so no frame handling, no polling and no protocol work is needed.
 *
 * A native Claude subagent cannot do this — it has no way to ask its parent
 * anything mid-run.
 */
export function createAskSupervisor(onAsk: (ask: Ask) => void): AskHandle {
  const waiting = new Map<string, {
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    ask: Ask;
  }>();
  let seq = 0;

  const tool = {
    name: "ask_supervisor",
    label: "Ask supervisor",
    description:
      "Ask the supervising Claude session a question and wait for its answer. Use when " +
      "you are blocked, or facing a judgement call your instructions did not settle. " +
      "Do not use it for anything you can answer by reading the repository — you will " +
      "be waiting on a human's attention.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question. Be specific." },
        context: { type: "string", description: "What you have already tried or found." },
      },
      required: ["question"],
    },
    execute(
      params: { question: string; context?: string },
      ctx: { signal?: AbortSignal },
    ): Promise<string> {
      const ask: Ask = {
        ask_id: `ask_${++seq}`,
        question: params.question,
        context: params.context,
      };
      return new Promise<string>((resolve, reject) => {
        waiting.set(ask.ask_id, { resolve, reject, ask });
        ctx.signal?.addEventListener("abort", () => {
          if (waiting.delete(ask.ask_id)) {
            reject(new Error("ask_supervisor was aborted"));
          }
        }, { once: true });
        onAsk(ask);
      });
    },
  };

  return {
    tool,
    answer(askId, text) {
      const w = waiting.get(askId);
      if (!w) return false;
      waiting.delete(askId);
      w.resolve(text);
      return true;
    },
    pending() {
      const first = waiting.values().next();
      return first.done ? null : first.value.ask;
    },
    cancelAll(reason) {
      for (const [, w] of waiting) w.reject(new Error(reason));
      waiting.clear();
    },
  };
}
