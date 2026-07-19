const ENDPOINT = process.env.PLAYWRIGHT_ENDPOINT ?? "https://playwright.etzhayyim.com";
const TOKEN = process.env.PLAYWRIGHT_DAEMON_TOKEN ?? "";

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const url = `${ENDPOINT}/xrpc/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`${method} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export interface Action {
  actionId: string;
  sessionId: string;
  op: string;
  args: Record<string, unknown>;
}

export const xrpc = {
  async dequeue(daemonId: string): Promise<{ action: Action | null }> {
    return call("com.etzhayyim.apps.playwright.dequeueAction", { daemonId });
  },
  async report(actionId: string, outcome: "ok" | "failed", result?: unknown, error?: string): Promise<unknown> {
    return call("com.etzhayyim.apps.playwright.reportActionResult", {
      actionId, outcome,
      result: result ?? null,
      error: error ?? "",
    });
  },
};

export function endpoint(): string { return ENDPOINT; }
