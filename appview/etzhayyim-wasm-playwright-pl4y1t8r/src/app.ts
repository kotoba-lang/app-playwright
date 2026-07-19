import {
  asAgentTool, createKyselyDb, createWorkerExport, withCapabilityTags,
  type HostSDK, nowISO, str, genID, nsid,
} from "@etzhayyim/kotodama-host-sdk";
// CHARTER-VIOLATION §substrate (centralized DB forbidden — migrate to AT MST + IPFS + Base L2)

const ACTOR_NAME = "playwright";
const ACTOR_NSID_NS = "playwright";
const ACTOR_DID = `did:web:${ACTOR_NAME}.etzhayyim.com`;

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, m => "_" + m.toLowerCase()).replace(/^_/, "");
}



function decodeParams(payload: any): Record<string, any> {
  if (!payload) return {};
  if (typeof payload === "object" && !(payload instanceof Uint8Array)) return payload as any;
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (bytes.length === 0) return {};
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
}

/**
 * com.etzhayyim.apps.playwright — Browser automation primitives.
 *
 * XRPC methods wrap Playwright operations. Execution routes to:
 *   target=local       → Mac daemon (headed capable, Keychain access)
 *   target=cf-browser  → com.etzhayyim.apps.cloudflareBrowserRender via CF_BROWSER_RENDER binding
 *
 * Session state in D1 PLAYWRIGHT_DB.session (sessionId, target, expiresAt).
 * Credentials never arrive as plaintext: use valueRef strings resolved per-op.
 */

const SESSION_TTL_LOCAL_SEC = 30 * 60;
const SESSION_TTL_CF_SEC = 5 * 60;
const OP_DEFAULT_TIMEOUT_MS = 30_000;
const OP_MAX_TIMEOUT_MS = 120_000;

function requireSessionId(params: any): string {
  const s = str(params?.sessionId ?? "");
  if (!s) throw new Error("sessionId required");
  return s;
}

async function enqueueLocalOp(env: any, sessionId: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  // For local target, ops are queued to the Mac daemon via PLAYWRIGHT_DB.action
  // with state=pending. The daemon's long-poll picks up by sessionId.
  const actionId = `act-${genID("act")}`;
  const enqueuedAtMs = Date.now();
  await env.PLAYWRIGHT_DB.prepare(
    `INSERT INTO action (action_id, session_id, op, args_json, state, enqueued_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(actionId, sessionId, op, JSON.stringify(args), nowISO()).run();

  // Poll result up to op's requested timeout, default 30s (Worker invocation bound).
  const timeout = Math.min(Number((args as any)?.timeout ?? OP_DEFAULT_TIMEOUT_MS), OP_MAX_TIMEOUT_MS);
  const deadline = Date.now() + timeout + 5_000;
  while (Date.now() < deadline) {
    const row = await env.PLAYWRIGHT_DB.prepare(
      "SELECT state, result_json, error, started_at, finished_at FROM action WHERE action_id = ?"
    ).bind(actionId).first() as { state: string; result_json?: string; error?: string } | null;
    if (row && (row.state === "ok" || row.state === "failed")) {
      const startedAtMs = row && (row as any).started_at ? Date.parse((row as any).started_at) : NaN;
      const finishedAtMs = row && (row as any).finished_at ? Date.parse((row as any).finished_at) : Date.now();
      const queueDelayMs = Number.isFinite(startedAtMs) ? Math.max(0, startedAtMs - enqueuedAtMs) : null;
      const execDurationMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;
      if (row.state === "ok" && row.result_json) {
        const result = JSON.parse(row.result_json);
        return {
          ...result,
          actionId,
          queueDelayMs,
          execDurationMs,
        };
      }
      if (row.state === "failed") return { error: row.error ?? "daemon op failed", actionId, queueDelayMs, execDurationMs };
      return {};
    }
    await new Promise(r => setTimeout(r, 400));
  }
  await env.PLAYWRIGHT_DB.prepare(
    "UPDATE action SET state = 'expired' WHERE action_id = ? AND state IN ('pending','running')"
  ).bind(actionId).run();
  return { error: "daemon did not respond within timeout" };
}

async function dispatchCfBrowser(env: any, sessionId: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  if (!env.CF_BROWSER_RENDER) return { error: "CF_BROWSER_RENDER binding not configured" };
  const url = `https://cloudflare-browser-render.etzhayyim.com/xrpc/com.etzhayyim.apps.cloudflareBrowserRender.dispatchOp`;
  const body = { sessionId, op, args };
  const res = await env.CF_BROWSER_RENDER.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  if (!res.ok) return { error: `cf-browser dispatch failed: ${res.status}` };
  return res.json();
}

async function getSession(env: any, sessionId: string): Promise<{ target: string; expires_at: string } | null> {
  return env.PLAYWRIGHT_DB.prepare(
    "SELECT target, expires_at FROM session WHERE session_id = ?"
  ).bind(sessionId).first() as Promise<{ target: string; expires_at: string } | null>;
}

async function runOp(env: any, sessionId: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  const sess = await getSession(env, sessionId);
  if (!sess) return { error: `unknown sessionId "${sessionId}"` };
  if (new Date(sess.expires_at).getTime() < Date.now()) return { error: `session ${sessionId} expired` };
  if (sess.target === "local") return enqueueLocalOp(env, sessionId, op, args);
  if (sess.target === "cf-browser") return dispatchCfBrowser(env, sessionId, op, args);
  return { error: `unknown target "${sess.target}"` };
}

async function writeRecord(db: any, collection: string, rkey: string, value: Record<string, unknown>): Promise<void> {
  const table = `vertex_${camelToSnake(ACTOR_NSID_NS)}_${camelToSnake(collection)}`;
  const now = new Date();
  const row: Record<string, unknown> = {
    vertex_id: `at://${ACTOR_DID}/com.etzhayyim.apps.${ACTOR_NSID_NS}.${collection}/${rkey}`,
    _seq: null,
    created_date: now.toISOString().slice(0, 10),
    sensitivity_ord: 100,
    owner_did: ACTOR_DID,
    rkey,
    repo: ACTOR_DID,
    created_at: now.toISOString(),
    org_id: "etzhayyim",
    user_id: "system",
    actor_id: `sys.${ACTOR_NAME}`,
  };
  for (const [k, v] of Object.entries(value)) {
    const sc = camelToSnake(k);
    if (sc in row) continue;
    row[sc] = (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
  }
  try {
    await db.insertInto(table as any).values(row as any).execute();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/duplicate|already exists|pk violation/i.test(msg)) {
      console.error(`[writeRecord] ${table} failed: ${msg.slice(0, 300)}`);
    }
  }
}

export default createWorkerExport((sdk: HostSDK) => {
  const env = sdk.env as any;
  const db = createKyselyDb(env.HYPERDRIVE) as any;

    sdk.app.command(nsid("com.etzhayyim.apps.playwright.sessionOpen"),
      async (_ctx, _p: any) => {
        const params = decodeParams(_p);
        const target = str(params?.target ?? "local");
        if (target !== "local" && target !== "cf-browser") return { error: "target must be 'local' or 'cf-browser'" };
        const sessionId = `${target === "local" ? "local" : "cf"}-${genID("sess")}`;
        const ttlSec = target === "local" ? SESSION_TTL_LOCAL_SEC : SESSION_TTL_CF_SEC;
        const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
        const openedAt = nowISO();
        await env.PLAYWRIGHT_DB.prepare(
          `INSERT INTO session (session_id, target, user_agent, locale, viewport_json, state, opened_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
        ).bind(
          sessionId, target,
          str(params?.userAgent ?? ""), str(params?.locale ?? ""),
          JSON.stringify(params?.viewport ?? null),
          openedAt, expiresAt,
        ).run();
        await writeRecord(db, "session", sessionId, { sessionId, target, openedAt, expiresAt });
        return { sessionId, target, expiresAt };
      },
      asAgentTool("Open a Playwright session (target: 'local' = Mac daemon, 'cf-browser' = CF Browser Rendering)."),
      withCapabilityTags("playwright", "session"),
    );

    sdk.app.command(nsid("com.etzhayyim.apps.playwright.sessionClose"),
      async (_ctx, _p: any) => {
        const params = decodeParams(_p);
        const sessionId = requireSessionId(params);
        await runOp(env, sessionId, "sessionClose", {});
        await env.PLAYWRIGHT_DB.prepare(
          "UPDATE session SET state = 'closed', closed_at = ? WHERE session_id = ?"
        ).bind(nowISO(), sessionId).run();
        return { sessionId, closed: true };
      },
      asAgentTool("Close a session."),
      withCapabilityTags("playwright", "session"),
    );

    const simpleOp = (opName: string, description: string) =>
      sdk.app.command(nsid(`com.etzhayyim.apps.playwright.${opName}`),
        async (_ctx, _p: any) => {
        const params = decodeParams(_p);
          const sessionId = requireSessionId(params);
          const { sessionId: _drop, ...args } = params as any;
          return runOp(env, sessionId, opName, args);
        },
        asAgentTool(description),
        withCapabilityTags("playwright", opName),
      );

    simpleOp("goto",       "Navigate to a URL. Args: {sessionId, url, waitUntil?}");
    simpleOp("fill",       "Fill an input. Args: {sessionId, selector, value? or valueRef?}");
    simpleOp("click",      "Click an element. Args: {sessionId, selector}");
    simpleOp("waitFor",    "Wait for a selector or load state. Args: {sessionId, selector?, state?, timeout?}");
    simpleOp("waitForTimeout", "Sleep inside the browser session. Args: {sessionId, timeout|ms}");
    simpleOp("scrape",     "Scrape text from a selector. Args: {sessionId, selector, parse: 'text'|'jpy'|'number'|'attr:<name>'}");
    simpleOp("responseBody", "Wait for a matching network response and return body. Args: {sessionId, url?|urlContains?|urlRegex?, timeout?}");
    simpleOp("snapshot",   "Persist sanitized HTML to R2. Args: {sessionId}");
    simpleOp("screenshot", "Persist PNG to R2. Args: {sessionId, fullPage?}");
    simpleOp("evaluate",   "Run an allowlisted browser-side action. Args: {sessionId, action, ...}");
    simpleOp("getUrl",     "Get current page URL. Args: {sessionId}");

    // ─────────────────────────────────────────────────────────────────────
    // Daemon interface — atomic claim + result report of pending actions
    // ─────────────────────────────────────────────────────────────────────
    sdk.app.command(nsid("com.etzhayyim.apps.playwright.dequeueAction"),
      async (_ctx, _p: any) => {
        const params = decodeParams(_p);
        const daemonId = str(params?.daemonId ?? "");
        if (!daemonId) return { error: "daemonId required" };
        const now = nowISO();

        // Expire stale actions
        await env.PLAYWRIGHT_DB.prepare(
          `UPDATE action SET state = 'expired' WHERE state IN ('pending','running')
             AND enqueued_at < ?`
        ).bind(new Date(Date.now() - 5 * 60 * 1000).toISOString()).run();

        // Claim one pending action scoped to target=local sessions
        const row = await env.PLAYWRIGHT_DB.prepare(
          `SELECT a.action_id, a.session_id, a.op, a.args_json
             FROM action a
             JOIN session s ON s.session_id = a.session_id
            WHERE a.state = 'pending' AND s.target = 'local' AND s.state = 'open'
            ORDER BY a.enqueued_at ASC LIMIT 1`
        ).first() as { action_id: string; session_id: string; op: string; args_json: string } | null;
        if (!row) return { action: null };

        const claim = await env.PLAYWRIGHT_DB.prepare(
          `UPDATE action SET state = 'running', started_at = ? WHERE action_id = ? AND state = 'pending'`
        ).bind(now, row.action_id).run();
        if (!claim.meta.changes) return { action: null };

        return {
          action: {
            actionId: row.action_id,
            sessionId: row.session_id,
            op: row.op,
            args: JSON.parse(row.args_json || "{}"),
          },
        };
      },
      asAgentTool("Daemon long-poll: atomically claim one pending action for a local session."),
      withCapabilityTags("playwright", "daemon", "dequeue"),
    );

    sdk.app.command(nsid("com.etzhayyim.apps.playwright.reportActionResult"),
      async (_ctx, _p: any) => {
        const params = decodeParams(_p);
        const actionId = str(params?.actionId ?? "");
        const outcome = str(params?.outcome ?? ""); // "ok" | "failed"
        if (!actionId || !outcome) return { error: "actionId and outcome required" };
        if (outcome !== "ok" && outcome !== "failed") return { error: "outcome must be 'ok' or 'failed'" };

        const result = params?.result ?? null;
        const errorMsg = str(params?.error ?? "");
        const now = nowISO();

        await env.PLAYWRIGHT_DB.prepare(
          `UPDATE action SET state = ?, result_json = ?, error = ?, finished_at = ?
             WHERE action_id = ?`
        ).bind(outcome, result ? JSON.stringify(result) : null, errorMsg || null, now, actionId).run();

        return { actionId, outcome, accepted: true };
      },
      asAgentTool("Daemon reports action outcome (ok|failed)."),
      withCapabilityTags("playwright", "daemon", "report"),
    );
});
