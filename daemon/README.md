# @etzhayyim/playwright-daemon

Local daemon for `com.etzhayyim.apps.playwright` target=local. Long-polls
`playwright.etzhayyim.com` for pending actions, executes via Playwright Chromium,
resolves `valueRef` (Keychain / 1Password / env / literal), reports results.

**Credentials never leave the Mac.**

## Install

```bash
cd 60-apps/etzhayyim-project-playwright/daemon
npm install
npm run install-browsers
```

## valueRef schemes

| Scheme | Example | Resolver |
|---|---|---|
| `literal:` | `literal:hello` | passthrough |
| `env:` | `env:MY_VAR` | `process.env.MY_VAR` |
| `keychain:` | `keychain:etzhayyim.shiharai.tokyo-waterworks/primary.password` | `security find-generic-password` + JSON key extract |
| `1password://` | `1password://Personal/Tokyo-Waterworks-Card/number` | `op read op://Personal/Tokyo-Waterworks-Card/number` |
| `vault://` | `vault://shiharai/tokyo-waterworks/customerNumber` | **Phase 4** (service-binding auth token) |

Keychain register example:

```bash
# JSON value: supports .jsonKey extraction via keychain:service/account.jsonKey
security add-generic-password \
  -s etzhayyim.shiharai.tokyo-waterworks \
  -a primary \
  -w '{"customerNumber":"0000","password":"...","totpSeed":"..."}'
```

## Run

```bash
PLAYWRIGHT_ENDPOINT=https://playwright.etzhayyim.com \
PLAYWRIGHT_DAEMON_TOKEN="$(etzhayyim agent-token --lxm com.etzhayyim.apps.playwright.dequeueAction)" \
npm run dev
```

Env vars:

| Var | Default | Description |
|---|---|---|
| `PLAYWRIGHT_ENDPOINT` | `https://playwright.etzhayyim.com` | Worker base URL |
| `PLAYWRIGHT_DAEMON_TOKEN` | — | Bearer token |
| `PLAYWRIGHT_DAEMON_ID` | `daemon-{hostname}-{uuid8}` | Unique id |
| `PLAYWRIGHT_POLL_INTERVAL_MS` | `1000` | Idle poll interval |
| `PLAYWRIGHT_SESSION_IDLE_MS` | `1800000` | Close session after N ms idle (30 min) |
| `PLAYWRIGHT_HEADLESS` | `true` | `false` for headed debug |
| `PLAYWRIGHT_SLOW_MO` | `0` | ms between actions |

## LaunchAgent (run on login)

```bash
cat > ~/Library/LaunchAgents/com.etzhayyim.playwright.daemon.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.etzhayyim.playwright.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/path/to/60-apps/etzhayyim-project-playwright/daemon/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLAYWRIGHT_ENDPOINT</key><string>https://playwright.etzhayyim.com</string>
    <key>PLAYWRIGHT_DAEMON_TOKEN</key><string>sk_live_…</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/playwright-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/playwright-daemon.err.log</string>
</dict>
</plist>
PLIST
launchctl load ~/Library/LaunchAgents/com.etzhayyim.playwright.daemon.plist
```

## Architecture

```
caller → com.etzhayyim.apps.playwright.<op> XRPC
           ↓ enqueue action (D1 session/action table)
           ↓ poll for result
                                          ← dequeueAction
                                          → reportActionResult
                                          : daemon loop
                                            1. xrpc.dequeue(daemonId)
                                            2. ensureSession(sessionId)
                                            3. dispatch(op, args, {page, context})
                                               ├─ valueRef resolve (Keychain/1Password)
                                               ├─ Playwright action
                                               └─ sanitize snapshot
                                            4. xrpc.report(ok|failed, result)
```

Sessions are held in daemon memory (`Map<sessionId, LiveSession>`) across
multiple ops so BPMN workflows can chain goto → fill → click → scrape
against the same Chromium page. Idle sessions sweep after 30 min.

## Security invariants

1. Credentials never transit the XRPC payload — only `valueRef` strings do
2. `.textContent`-only scraping — no `innerHTML`
3. Snapshot redacts `<input type=password>` + card-number regex
4. `evaluate` op disabled in Phase 1 (CSP hole risk)
5. Sessions isolated per sessionId; one biller's cookies don't leak

## Troubleshooting

| Symptom | Fix |
|---|---|
| `keychain entry missing` | `security add-generic-password …` |
| `1password 'op' CLI not installed` | `brew install --cask 1password-cli` then `op signin` |
| `evaluate op not yet enabled` | Expected in Phase 1; use scrape/fill/click instead |
| `authorization: Bearer` 401 | Re-mint `etzhayyim agent-token --lxm com.etzhayyim.apps.playwright.dequeueAction` |
