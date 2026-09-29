# etzhayyim-project-playwright — Browser automation primitives actor

`did:web:playwright.etzhayyim.com` / nanoid `pl4y1t8r`。Browser 操作を XRPC primitive
に分解。`com.etzhayyim.apps.bpmn` の serviceTask から呼ばれる汎用 capability。

## Scope

- 汎用 (shiharai / common-crawl / keiyaku / kaisya ... 全 app 共有)
- **Execution target**: `local` (Mac daemon) / `cf-browser` (→ `com.etzhayyim.apps.cloudflareBrowserRender` delegate)
- **Credential**: `valueRef: "vault://..."` 記法で vault.etzhayyim.com から ephemeral 取得 (ADR-0029)
- recipe / orchestration は **持たない** — BPMN actor の責務

## XRPC surface (11 methods)

| method | target | 破壊度 | 概要 |
|---|---|---|---|
| `sessionOpen` | local/cf-browser | safe | `{target, userAgent?, locale?, viewport?}` → `{sessionId, executor}` |
| `sessionClose` | both | safe | |
| `goto` | both | safe | `{sessionId, url, waitUntil}` |
| `fill` | both | safe | `{sessionId, selector, value or valueRef}` |
| `click` | both | safe | `{sessionId, selector}` |
| `waitFor` | both | safe | `{sessionId, selector?, state?, timeout}` |
| `scrape` | both | safe | `{sessionId, selector, parse: 'text'\|'jpy'\|'number'\|'attr:<name>'}` |
| `snapshot` | both | safe | `{sessionId}` → B2 CID (redacted HTML) |
| `screenshot` | both | safe | `{sessionId, fullPage?}` → B2 CID (PNG) |
| `evaluate` | both | moderate | `{sessionId, jsCode}` — allowlist 制限 |
| `getUrl` | both | safe | `{sessionId}` → current URL |

## Data model

- `vertex_playwright_session` — active session (sessionId, target, openedAt, expiresAt)
- `vertex_playwright_action` — 1 XRPC call = 1 row (append-only audit)
- `vertex_playwright_artifact` — B2 CID of snapshot/screenshot

Migration: `30-graph/graph-schema/migrations/20260419140000_vertex_playwright_tables.ts`

## valueRef protocol

`valueRef` 文字列 → credential / variable 解決:

| scheme | 意味 | 解決先 |
|---|---|---|
| `vault://path/to/secret` | vault.etzhayyim.com 内 secret | `VAULT_SERVICE` binding |
| `keychain:etzhayyim.shiharai.<biller>/<key>` | macOS Keychain (local daemon のみ) | `security find-generic-password` |
| `1password://<vault>/<item>/<field>` | 1Password (local daemon のみ) | `op` CLI |
| `env:<NAME>` | Worker env var | `env.<NAME>` |
| `literal:<value>` | plaintext (debug 用) | そのまま |

`cf-browser` target では `keychain:` と `1password://` は拒否 (local 物理アクセス前提)。

## Execution path

```
bpmn serviceTask → playwright.<op> XRPC
                        │
         ┌──────────────┴──────────────┐
         ▼                             ▼
  target=local                  target=cf-browser
  ┌─────────────┐          ┌────────────────────┐
  │ Mac daemon  │          │ cloudflareBrowser  │
  │ (長 poll)   │          │ Render actor       │
  │ Playwright  │          │ @cloudflare/       │
  │ chromium    │          │ playwright         │
  └─────────────┘          └────────────────────┘
```

- `sessionId` は namespace 分離: `local-<uuid>` / `cf-<uuid>`
- XRPC 呼出毎に state = D1 `session` table で track (sticky routing)

## Key conventions

- PII redact: `snapshot` / `screenshot` で必ず `<input type="password">` + card number regex を redact
- timeout default: 30s / override max 120s
- `evaluate` は JS allowlist: `document.querySelector*`, `window.location.*`, `.textContent`. eval-arbitrary は禁止
- 1 session あたり TTL: local=30分 / cf-browser=5分 (CF cost control)
- credential は XRPC payload で **plaintext 渡さない** — `valueRef` のみ

## Phase

- **Phase 1** (this PR): 11 XRPC method, 2 execution target stub, local daemon skeleton
- **Phase 2**: CF Browser Rendering integration (→ `com.etzhayyim.apps.cloudflareBrowserRender`)
- **Phase 3**: 1Password / Keychain valueRef resolver
