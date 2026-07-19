#!/usr/bin/env node
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { xrpc, endpoint } from "./xrpc.js";
import { dispatch, knownOps, notePageResponse } from "./ops.js";

const DAEMON_ID = process.env.PLAYWRIGHT_DAEMON_ID ?? `daemon-${hostname()}-${randomUUID().slice(0, 8)}`;
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== "false";
const SLOW_MO = Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0);
const POLL_INTERVAL_MS = Number(process.env.PLAYWRIGHT_POLL_INTERVAL_MS ?? 1000);
const SESSION_IDLE_MS = Number(process.env.PLAYWRIGHT_SESSION_IDLE_MS ?? 30 * 60 * 1000);

interface LiveSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

const sessions = new Map<string, LiveSession>();

async function ensureSession(sessionId: string): Promise<LiveSession> {
  let sess = sessions.get(sessionId);
  if (sess) { sess.lastUsedAt = Date.now(); return sess; }
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("response", async (response) => {
    try {
      const text = (await response.text()).slice(0, 200_000);
      notePageResponse(page, {
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        text,
        ts: Date.now(),
      });
    } catch {}
  });
  sess = { sessionId, browser, context, page, lastUsedAt: Date.now() };
  sessions.set(sessionId, sess);
  return sess;
}

async function closeSession(sessionId: string): Promise<void> {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  try { await sess.context.close(); } catch {}
  try { await sess.browser.close(); } catch {}
  sessions.delete(sessionId);
}

async function sweepIdleSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > SESSION_IDLE_MS) {
      console.log(`[sweep] closing idle session ${id}`);
      await closeSession(id);
    }
  }
}

async function handleAction(action: Awaited<ReturnType<typeof xrpc.dequeue>>["action"]) {
  if (!action) return;
  console.log(`[action ${action.actionId}] session=${action.sessionId} op=${action.op}`);
  const startedAtMs = Date.now();
  try {
    if (action.op === "sessionClose") {
      await closeSession(action.sessionId);
      await xrpc.report(action.actionId, "ok", { ok: true, daemonDurationMs: Date.now() - startedAtMs });
      return;
    }
    const sess = await ensureSession(action.sessionId);
    const result = await dispatch(action.op, action.args, { page: sess.page, context: sess.context });
    const daemonDurationMs = Date.now() - startedAtMs;
    console.log(`[action ${action.actionId}] ok durationMs=${daemonDurationMs}`);
    await xrpc.report(
      action.actionId,
      "ok",
      (result && typeof result === "object")
        ? { ...(result as Record<string, unknown>), daemonDurationMs }
        : { value: result, daemonDurationMs },
    );
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    console.error(`[action ${action.actionId}] failed durationMs=${Date.now() - startedAtMs}: ${msg}`);
    await xrpc.report(action.actionId, "failed", null, msg);
  }
}

async function main() {
  console.log(`[playwright-daemon] start id=${DAEMON_ID} endpoint=${endpoint()}`);
  console.log(`[playwright-daemon] ops: ${knownOps().join(", ")}`);
  let running = true;
  process.on("SIGINT", () => { console.log("[SIGINT] draining"); running = false; });
  process.on("SIGTERM", () => { console.log("[SIGTERM] draining"); running = false; });

  const sweepTimer = setInterval(() => { sweepIdleSessions().catch(e => console.error(e)); }, 60_000);

  while (running) {
    try {
      const { action } = await xrpc.dequeue(DAEMON_ID);
      if (action) {
        await handleAction(action);
      } else {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (e: any) {
      console.error(`[loop] ${String(e?.message ?? e).slice(0, 300)}`);
      await new Promise(r => setTimeout(r, 5_000));
    }
  }

  clearInterval(sweepTimer);
  for (const id of [...sessions.keys()]) await closeSession(id);
  console.log("[playwright-daemon] exited");
}

main().catch(e => { console.error(e); process.exit(1); });
