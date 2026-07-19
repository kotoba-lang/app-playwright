import type { Page, BrowserContext } from "playwright";
import { resolveValueRef } from "./value-ref.js";

/**
 * Generic dispatcher — executes any com.etzhayyim.apps.playwright op against a
 * Playwright Page. Keeps parity with the XRPC schema.
 *
 * Returns the op result payload (to be POSTed back to reportActionResult).
 * Throws on unrecoverable errors (caught by caller).
 */
export type OpHandler = (args: any, ctx: OpContext) => Promise<unknown>;

export interface OpContext {
  page: Page;
  context: BrowserContext;
}

type RecentResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  text: string;
  ts: number;
};

const recentResponses = new WeakMap<Page, RecentResponse[]>();
const MAX_RECENT_RESPONSES = 40;
const MAX_RESPONSE_BODY_CHARS = 200_000;

export function notePageResponse(page: Page, response: RecentResponse): void {
  const list = recentResponses.get(page) ?? [];
  list.push(response);
  while (list.length > MAX_RECENT_RESPONSES) list.shift();
  recentResponses.set(page, list);
}

function findRecentResponse(page: Page, args: any): RecentResponse | null {
  const list = recentResponses.get(page) ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i]!;
    if (responseMatches(item.url, args)) return item;
  }
  return null;
}

function requireString(value: unknown, field: string): string {
  const out = String(value ?? "");
  if (!out) throw new Error(`${field} required`);
  return out;
}

function responseMatches(url: string, args: any): boolean {
  const exact = String(args.url ?? "");
  const contains = String(args.urlContains ?? "");
  const regex = String(args.urlRegex ?? "");
  if (exact) return url === exact;
  if (contains) return url.includes(contains);
  if (regex) return new RegExp(regex).test(url);
  throw new Error("responseBody requires one of url, urlContains, or urlRegex");
}

async function runAllowedEvaluate(args: any, { page }: OpContext): Promise<unknown> {
  const action = requireString(args.action, "action");
  if (action === "bodyText") {
    const selector = String(args.selector ?? "body");
    const text = await page.locator(selector).first().innerText({ timeout: Number(args.timeout ?? 30_000) });
    return { value: text, byteSize: text.length };
  }
  if (action === "textContent") {
    const selector = requireString(args.selector, "selector");
    const text = (await page.locator(selector).first().textContent({ timeout: Number(args.timeout ?? 30_000) })) ?? "";
    return { value: text, byteSize: text.length };
  }
  if (action === "attrAll") {
    const selector = requireString(args.selector, "selector");
    const attr = requireString(args.attr, "attr");
    const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50)));
    const values = await page.locator(selector).evaluateAll(
      (nodes, params: { attr: string; limit: number }) => (
        nodes
          .map((node) => (node as Element).getAttribute(params.attr) ?? "")
          .filter(Boolean)
          .slice(0, params.limit)
      ),
      { attr, limit },
    );
    return { values };
  }
  if (action === "fetchJson") {
    const url = requireString(args.url, "url");
    const pageUrl = new URL(page.url());
    const targetUrl = new URL(url, page.url());
    if (targetUrl.origin !== pageUrl.origin) {
      throw new Error(`fetchJson origin mismatch: ${targetUrl.origin}`);
    }
    const result = await page.evaluate(async ({ target, timeoutMs, headers, method, body }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(target, {
          method,
          headers,
          body,
          credentials: "include",
          signal: controller.signal,
        });
        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          url: res.url,
          text,
        };
      } finally {
        clearTimeout(timer);
      }
    }, {
      target: targetUrl.toString(),
      timeoutMs: Number(args.timeout ?? 30_000),
      headers: (args.headers && typeof args.headers === "object") ? args.headers : {},
      method: String(args.method ?? "GET"),
      body: typeof args.body === "string" ? args.body : undefined,
    });
    let parsed: unknown = null;
    try { parsed = JSON.parse(String((result as any).text ?? "")); } catch {}
    return { ...(result as any), json: parsed };
  }
  throw new Error(`evaluate action not allowed: ${action}`);
}

function parseJpy(text: string): number {
  const m = text.replace(/[,，]/g, "").match(/([0-9]+)/);
  return m ? Number(m[1]) : 0;
}

function parseValue(raw: string, parseSpec: string): { value: unknown; raw: string } {
  if (parseSpec === "jpy") return { value: parseJpy(raw), raw };
  if (parseSpec === "number") return { value: Number(raw.replace(/[^0-9.-]/g, "")), raw };
  if (parseSpec.startsWith("attr:")) return { value: raw, raw };
  return { value: raw.trim(), raw };
}

async function resolveFillValue(args: any): Promise<string> {
  if (typeof args.value === "string") return args.value;
  if (typeof args.valueRef === "string" && args.valueRef) return resolveValueRef(args.valueRef);
  throw new Error("fill requires either value or valueRef");
}

const ops: Record<string, OpHandler> = {
  async goto(args, { page }) {
    const url = String(args.url);
    const waitUntil = (args.waitUntil ?? "domcontentloaded") as any;
    const timeout = Number(args.timeout ?? 30_000);
    const resp = await page.goto(url, { waitUntil, timeout });
    return { url: page.url(), status: resp?.status() ?? 0 };
  },

  async fill(args, { page }) {
    const selector = String(args.selector);
    const value = await resolveFillValue(args);
    await page.fill(selector, value, { timeout: Number(args.timeout ?? 30_000) });
    return { ok: true };
  },

  async click(args, { page }) {
    await page.click(String(args.selector), { timeout: Number(args.timeout ?? 30_000) });
    return { ok: true };
  },

  async waitFor(args, { page }) {
    const timeout = Number(args.timeout ?? 30_000);
    if (args.selector) {
      await page.waitForSelector(String(args.selector), {
        state: (args.state as any) ?? "visible",
        timeout,
      });
    } else if (args.state) {
      await page.waitForLoadState(args.state as any, { timeout });
    } else {
      await page.waitForLoadState("networkidle", { timeout });
    }
    return { ok: true };
  },

  async waitForTimeout(args, { page }) {
    await page.waitForTimeout(Number(args.timeout ?? args.ms ?? 1000));
    return { ok: true };
  },

  async scrape(args, { page }) {
    const selector = String(args.selector);
    const parseSpec = String(args.parse ?? "text");
    const locator = page.locator(selector).first();
    let raw: string;
    if (parseSpec.startsWith("attr:")) {
      const attr = parseSpec.slice("attr:".length);
      raw = (await locator.getAttribute(attr)) ?? "";
    } else {
      raw = (await locator.textContent()) ?? "";
    }
    return parseValue(raw, parseSpec);
  },

  async snapshot(_args, { page }) {
    // Sanitize HTML before return — caller (Worker) uploads to R2.
    const html = await page.content();
    const redacted = html
      .replace(/(<input[^>]*type=["']password["'][^>]*value=["'])[^"']*/gi, "$1[REDACTED]")
      .replace(/(\b(?:\d[ -]*?){13,19}\b)/g, "[CARD_REDACTED]");
    return { html: redacted, byteSize: redacted.length };
  },

  async screenshot(args, { page }) {
    const buf = await page.screenshot({ fullPage: Boolean(args.fullPage ?? false) });
    return { pngBase64: Buffer.from(buf).toString("base64"), byteSize: buf.length };
  },

  async responseBody(args, { page }) {
    const recent = findRecentResponse(page, args);
    if (recent) {
      let json: unknown = null;
      try { json = JSON.parse(recent.text); } catch {}
      return {
        url: recent.url,
        status: recent.status,
        headers: recent.headers,
        text: recent.text,
        json,
        byteSize: recent.text.length,
        source: "recent-buffer",
      };
    }
    const timeout = Number(args.timeout ?? 30_000);
    const response = await page.waitForResponse(
      (res) => responseMatches(res.url(), args),
      { timeout },
    );
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch {}
    return {
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
      text,
      json,
      byteSize: text.length,
      source: "live-wait",
    };
  },

  async evaluate(args, ctx) {
    return runAllowedEvaluate(args, ctx);
  },

  async getUrl(_args, { page }) {
    return { url: page.url() };
  },

  async sessionClose(_args, { context }) {
    await context.close();
    return { ok: true };
  },
};

export async function dispatch(op: string, args: any, ctx: OpContext): Promise<unknown> {
  const handler = ops[op];
  if (!handler) throw new Error(`unknown op "${op}"`);
  return handler(args, ctx);
}

export function knownOps(): string[] { return Object.keys(ops); }
