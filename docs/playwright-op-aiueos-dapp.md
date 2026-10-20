# app-playwright（primitive 判定）— itonami（dapp）上の分散型設計

状態: 第 1 スライス実装（2026-10-20）。正本はこの文書。
追跡: Linear JUN-128（親 JUN-116）。

## 位置づけ

app-playwright は**ブラウザ自動化 primitive の actor** —— XRPC 11 method に
分解された汎用 capability（全 app 共有、BPMN serviceTask から呼ばれる）。
**recipe / orchestration は持たない**（BPMN actor の責務 —— 範囲を狭く保つ）。

## このスライス: primitive 判定コア

| 層 | 実体 | 状態 |
|---|---|---|
| 判定コア guest | `aiueos/playwright_op.cljk` — eval-judgment（**evaluate のみ moderate = allowlist 制限**、他 10 method は safe）/ valueref-ok（**keychain / 1password は local daemon のみ** — cf-browser では拒否）/ fill-admission（**value か valueRef のどちらか必須**）/ audit-ok（**1 XRPC 呼び出し = 1 行の append-only 監査**） | **実装済み・実測** |
| 記述子 | `aiueos/playwright-op.edn` | **実装済み** |
| parity | `cljs/test/playwright/op_parity_test.cljk` — 正本（AGENTS.md + ops.ts）の破壊度・valueRef・fill 規則・監査形と一致 | **実装済み・実測** |

実測: `amu test aiueos/playwright_op.cljk` → **15/15**（jvm-kir / js / wasm）。
parity → 3 tests / 10 assertions / 0 failures。

## 正本の正確な規則（guest はこれに追従）

- **破壊度**: sessionOpen / sessionClose / goto / fill / click / waitFor /
  scrape / snapshot / screenshot / getUrl は **safe**、**evaluate のみ
  moderate**（`{sessionId, jsCode}` — **allowlist 制限**）。
- **valueRef プロトコル（5 scheme）**: `vault://`（VAULT_SERVICE binding）/
  `keychain:etzhayyim.shiharai...`（**local daemon のみ**）/
  `1password://`（**local daemon のみ**）/ `env:<NAME>` / `literal:<value>`。
  「**cf-browser target では keychain: と 1password:// は拒否**」（local 物理
  アクセス前提）。credential は XRPC payload で**平文渡ししない — valueRef のみ**。
- **PII redact**: snapshot / screenshot では `<input type="password">` と
  カード番号 regex を必ず redact（host の処理だが規則として記録）。
- **fill は value か valueRef のどちらか必須**（両無しは throw）。
- **1 XRPC 呼び出し = 1 行**（vertex_playwright_action、append-only audit）。

## 未実装境界

- evaluate の allowlist そのもの（中身の許可リスト）。
- session の有効期限（expiresAt）判定。
- valueRef 解決の実体（VAULT_SERVICE / `op` CLI / Keychain = host）。
- mon（DNA）化、aiueos session 載せ（fleet 共通）。
