# Grok Bot desktop supplemental collector — design sketch

Status: **implemented** (feat/grok-bot-cursor-partition). Live CSV verify on goatarchy confirmed Bot models + Free cost gotcha; do not push experimental sync with live data until product review.

## Context

Cribble today:

| Source | What “grok” means | Path |
| --- | --- | --- |
| **ccusage primary** | **Grok Build CLI** only (`ccusage grok` → `GROK_HOME` / `~/.grok`, models like `grok-4.6-build`) | Local session files (`updates.jsonl` / `summary.json`) |
| **Supplemental** | Prime Agent + Cursor IDE | `lib/supplemental.js` → `prime` + `lib/cursor.js` |
| **Grok Bot desktop** | Thin Electron client; usage metered on the **Cursor account** weekly pool (SuperGrok link / Cursor plan) | **Not collected** as its own provider |

Grok Bot is not Grok Build CLI. Dedup between a Bot collector and ccusage `grok` is a non-issue: different products and different on-disk trees (`~/.config/Grok Bot` + cloud box vs `~/.grok`).

## How the in-app Usage / limits view gets numbers

Evidence from goatarchy paths (prior local-exec listings) plus the live `host-main.cjs` / sand stack on the box:

### Network (authoritative for meters)

Connect/protobuf `aiserver.v1.DashboardService` (and related) RPCs, including:

| RPC | Role |
| --- | --- |
| **`GetSandUsageStatus`** | In-app weekly meter: `usage_percent`, period start / next reset, SuperGrok / Cursor plan labels, on-demand eligibility (`SandOnDemandSettings.dashboard_url`), trial flags. **Pool %, not daily token rows.** |
| `GetUsageLimitStatusAndActiveGrants` | Limit policy + active credit grants / reset hints |
| `GetCurrentPeriodUsage` | Plan vs spend-limit buckets (`PlanUsage` spend cents / percents) |
| `GetClientUsageData` | Named cost items (`NameToCost`) |
| `GetFilteredUsageEvents` / `GetAggregatedUsageEvents` | Event-level / aggregated usage (model, tokens, kind, cloud agent id, …) |

HTTP companion already used by cribble’s Cursor collector:

- `GET https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens`
- Auth: `WorkosCursorSessionToken` cookie (built from Cursor `state.vscdb` JWT + user id; never logged/uploaded)

Docs + Cursor staff (Sep 2026): Grok Bot chats / routines / CUA draw from the **Grok Bot weekly pool**; Spending rows commonly appear as models `grok-bot-default`, `grok-bot-automation`, `grok-bot-cua` (legacy: `sand-default` / `sand-automation`). Cloud agents *launched by* the Bot bill as normal Cursor cloud-agent rows.

### Local cache (not a clean usage export)

Observed on goatarchy (read-only inventory; do not treat as a schema):

| Path | Notes |
| --- | --- |
| `~/.config/Grok Bot/` | Electron app userData (0.51.x class installs under `/opt/Grok Bot`) |
| `~/.config/Grok Bot/sand-client-persistence/*.blob` | Opaque content-addressed blobs — **not** a documented daily usage ledger |
| `~/.grokbot/` (`SAND_DATA_ROOT`) | Host/agent state: transcripts, `store.db`, gateway — **prompts/transcripts; privacy-sensitive; not for cribble** |
| Chromium profile under `~/.config/Grok Bot/` (Local Storage / IndexedDB / Cookies) | May cache UI; would require auth material — **out of scope / redact** |

**Do not** scrape transcripts, cookies, or keyring secrets for collection.

## Collector contract (existing supplemental)

From `lib/cursor.js`, `lib/supplemental.js`, `lib/usage.js`:

### Record shape (pre-wire daily row)

Each supplemental day/model row should provide:

- `date` — `YYYY-MM-DD` in the collection timezone  
- `provider` — canonical id (e.g. `cursor`, `prime-agent`)  
- `overlapProviders` — list used for **dedup vs ccusage** (same calendar day)  
- `agent` — display/agent label  
- `modelsUsed` — string[]  
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens` — non-negative safe integers  
- `totalCost` — finite ≥ 0  
- `recordKey` — sha256 hex (ledger identity); stripped before persist map values  

`usage.js` normalizes to wire days: `agents`, `models`, four token fields, `totalTokens`, `costUsd`.

### Ledger

- Cursor: `~/.config/cribble-agent/cursor-usage-ledger.json` (schemaVersion 1, timezone, records map)  
- Prime: `prime-usage-ledger.json`  
- Retention ~400 days; atomic write (`wx` tmp + rename); mode `0600`  
- Cursor: replace-by-date with **never-lower** guard + warning; timezone change clears ledger  

### Overlap / dedup

`mergeUsageReports(primaryReports, supplemental)`:

- Build per-date provider set from **ccusage** rows  
- Keep a supplemental row only if **none** of `provider` ∪ `overlapProviders` appear in that date’s primary providers  
- ccusage **wins** on conflict  

Implication: a Bot collector must **not** use overlapProviders that collide with ccusage’s grok provider on the same day unless that collision is intentional. Prefer `overlapProviders: ["grok-bot"]` (new id) so Build CLI `grok` and Bot never fight.

### Failure behavior

- Cursor: refresh failures → **ledger fallback** + warning (must not erase prior Cursor totals)  
- Supplemental load failure in `loadUsage` → **hard throw** (partial supplemental must not upload and wipe prior days)  
- Env kill switches: `CRIBBLE_CURSOR=0|false|off` skips refresh (keeps ledger)

## Does Cursor’s export already cover Grok Bot?

| Question | Answer | Confidence |
| --- | --- | --- |
| Same account / pool? | Yes — Bot meters on the Cursor account weekly pool | High (docs) |
| Are Bot events in `export-usage-events-csv`? | **Likely yes** as Model rows (`grok-bot-*` / legacy `sand-*`), possibly with Kind / Cloud Agent ID | Medium — confirm on a real CSV from this account |
| Does cribble attribute them as Bot today? | **No** — all CSV rows become `provider: "cursor"`, `agent: "cursor"` | High (code) |
| What’s missing for split? | Product label / `application_type`; weekly pool % (only on `GetSandUsageStatus`); Kind/Cloud Agent columns ignored by parser | High |

**Recommendation:** treat this as **attribution inside / beside the Cursor collector**, not a new local Electron scraper — once a sample CSV is checked.

## Feasibility

**Verdict: go (CSV attribution path) / no-go (local Electron ledger) / needs product confirmation (weekly % meter).**

| Approach | Data? | Privacy | Reliability | Rec |
| --- | --- | --- | --- | --- |
| A. Parse Cursor CSV; split models matching `^(grok-bot-|sand-(default\|automation))` into `provider/agent: grok-bot` | Y if present in export | Same as Cursor (cookie local-only) | Same as Cursor + model allowlist drift | **Preferred** |
| B. Call `GetFilteredUsageEvents` / Dashboard Connect with same session | Y | Same | More fragile than CSV | Optional later |
| C. Call `GetSandUsageStatus` only | Pool % only — **not** cribble daily tokens | Auth | Good for UI meters, wrong schema | Out of scope for ingest |
| D. Read `sand-client-persistence` / `~/.grokbot` transcripts | N for clean tokens | **Violates** no-prompts rule | Opaque / brittle | **Refuse** |

## Design sketch (approach A)

### Data source

Reuse `fetchCursorUsageCsv` / session extraction in `lib/cursor.js`. After `parseCursorCsv`, partition rows:

- **Cursor IDE (+ cloud agents):** everything else  
- **Grok Bot desktop:** model name matches Bot markers (configurable regex)

Optional later: honor CSV `Kind` / `Cloud Agent ID` (present in fixtures; ignored today) so cloud agents launched *from* Bot stay under `cursor`.

### Record schema

Same supplemental daily row as Cursor, with:

```text
provider: "grok-bot"
overlapProviders: ["grok-bot"]   # do NOT list "cursor" or ccusage "grok"
agent: "grok-bot"
modelsUsed: [<csv model>]
```

Ledger: `grok-bot-usage-ledger.json` **or** extend cursor ledger with a `source` field per record (prefer **separate ledger** for clear CRIBBLE_GROK_BOT kill switch without disturbing Cursor days).

### Files to add/change

| File | Change |
| --- | --- |
| `lib/cursor.js` | Partition helpers; or call shared `partitionCursorCsv(rows)` |
| `lib/grok-bot.js` (**new**) | `loadGrokBotUsage` — thin wrapper: fetch via Cursor session, filter models, ledger persist (mirror Cursor never-lower rules) |
| `lib/supplemental.js` | `loadSupplementalUsage` also merges `loadGrokBotUsage` |
| `index.js` / README | Document `CRIBBLE_GROK_BOT` |
| `test/grok-bot.test.js` + fixture CSV with `grok-bot-default` rows | Unit tests |

### Env flags

- `CRIBBLE_GROK_BOT=0|false|off` — skip Bot partition / refresh (keep Bot ledger)  
- Reuse Cursor disable: if `CRIBBLE_CURSOR=0`, Bot collector that depends on the same CSV should also skip refresh (document coupling) **or** still allow Bot-only refresh with the same cookie path (prefer: Bot refresh independent but shares session reader)

### Dedup vs ccusage grok CLI

- ccusage provider for Build CLI stays whatever ccusage emits (typically grok-family models under its own agent label)  
- Bot uses `overlapProviders: ["grok-bot"]` only  
- Never parse `~/.grok` in the Bot collector  

### Test plan

1. Fixture CSV containing `grok-bot-default` / `grok-bot-automation` / `grok-bot-cua` + normal Cursor models → assert split providers and token sums.  
2. Fixture with only Cursor models → Bot daily empty; Cursor unchanged.  
3. Ledger never-lower when Bot slice shrinks.  
4. `CRIBBLE_GROK_BOT=0` returns prior Bot ledger only.  
5. Manual (goatarchy): one real `export-usage-events-csv` pull; confirm Bot models present; **do not** `cribble sync` with experimental data.  
6. Privacy review: no transcript paths; cookie only on stdin to fetch worker.

## Open questions

1. ~~On this account’s live CSV, do `grok-bot-*` rows appear, and with what Kind / Cloud Agent ID values?~~ **Closed:** models `grok-bot-default` / `grok-bot-automation` / `grok-bot-cua` appear; Kind=`free`; Cloud Agent ID and Automation IDs empty on Bot rows. Literal Cost `Free` must parse as 0 (same as Included).  
2. Should Bot rows that are “Included” (weekly pool) report `totalCost: 0` like Cursor’s Included handling, while still counting tokens?  
3. Product: is there a public per-event export filtered by `application_type=grok_bot` (Enterprise analytics mention this field for audit — not confirmed on the individual CSV)?  
4. Should weekly pool **percentage** ever be synced (would need a different Cribble metric than daily tokens)?

## Host write note

Implemented against the cribble-agent checkout mirrored at
`/workspace/cribble-agent-upstream` (same commit as goatarchy main). Parent
should ensure goatarchy `/home/goat/PROJECTS/cribble-agent` receives this branch
when `machineId` Shell is available.
