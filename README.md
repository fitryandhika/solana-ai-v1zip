# Solana AI — V1 (Realtime Solana New-Token Scanner)

Solana AI detects newly tradable Solana tokens as early as reasonably
possible, collects realtime market data on them, calculates a simple
deterministic "Opportunity Score," stores historical snapshots, and shows the
best candidates on a dashboard.

**This is V1 — a foundation, not a finished trading system.** It does not do
Smart Money tracking, rug/risk detection, news/social analysis, machine
learning, or automated trading. See [Future Roadmap](#future-roadmap).

> ⚠️ **Disclaimer:** Solana AI provides market analytics and experimental
> signals. It does not guarantee future price performance and is not
> financial advice. Newly launched tokens can be extremely volatile and may
> lose most or all of their value.

---

## Overview

```
Solana blockchain
      ↓
Realtime token/pool activity discovery   (Solana WebSocket)
      ↓
DexScreener market data                  (confirm tradable pair, get metrics)
      ↓
Basic market analysis                    (momentum, buy/sell pressure)
      ↓
Opportunity Score                        (deterministic, 0-100)
      ↓
Supabase                                 (tokens + historical snapshots)
      ↓
Dashboard                                (Next.js, dark UI, mobile-friendly)
```

## Important distinction: BLOCKCHAIN REALTIME vs MARKET DATA POLLING

These are two different things and this project is careful not to blur them:

- **Blockchain realtime** — the scanner subscribes to live Solana program
  logs over a WebSocket connection (`lib/solana/websocket.js`). This is what
  lets us notice new pool/pair activity as it happens, instead of discovering
  tokens only when someone else's "trending" list catches up.
- **Market data polling** — once a token is confirmed, its price/volume/
  liquidity are refreshed by periodically calling the DexScreener REST API
  (`lib/providers/dexscreener.js`) on an interval (`MARKET_POLL_INTERVAL_MS`).
  This is polling, not a push feed — DexScreener does not offer Solana token
  metrics over WebSocket in a way this MVP relies on.

If the WebSocket connection drops, the scanner falls back to a slower,
conservative DexScreener poll for discovery (never fabricated data) and marks
itself `DEGRADED` until the WebSocket reconnects.

---

## Architecture

```
solana-ai/
├── app/                    Next.js App Router — pages + API routes
│   ├── page.js              Dashboard page
│   ├── token/[address]/     Token detail page
│   └── api/                 tokens, token/[address], scanner, health
├── components/              React UI components (dashboard, table, cards, chart)
├── lib/
│   ├── solana/websocket.js  Realtime blockchain discovery (transport only)
│   ├── providers/dexscreener.js   The ONLY module that calls DexScreener
│   ├── analyzer/             momentum.js, opportunity.js — deterministic scoring
│   ├── database/             supabase.js, tokens.js, snapshots.js
│   └── utils/format.js       Shared formatting helpers
├── worker/scanner.js         Standalone long-running scanner process
├── database/schema.sql       Supabase schema
└── tests/                    Unit tests (mocked, no live network required)
```

The web app (Next.js/Vercel) and the scanner (`worker/scanner.js`) are
**separate processes** that share one Supabase database. The web app never
opens a long-lived WebSocket itself (Vercel serverless functions can't host
one) — it only reads what the scanner has already written.

---

## Data sources

### 1. Solana RPC WebSocket
Used for realtime discovery only — subscribing to logs from well-known
Solana AMM/DEX program IDs (Raydium, Orca Whirlpools, Pump.fun) to notice
pool/pair-related activity as it happens. Configured via `SOLANA_RPC_URL` /
`SOLANA_WS_URL`. The public `api.mainnet-beta.solana.com` endpoint works for
development but is shared, rate-limited infrastructure — for anything beyond
light testing, use a dedicated provider (Helius, QuickNode, Triton, etc).

### 2. DexScreener API
Used for all market/pair data: price, liquidity, market cap, volume,
transaction counts, pair creation time, price changes. This is also how a
candidate address from the blockchain gets **confirmed** as an actual
tradable token — not every on-chain event is a real token, so nothing is
stored until DexScreener confirms a pair exists.

### 3. Supabase (Postgres)
Stores `tokens`, `token_snapshots` (append-only time series), and
`scanner_status`. The web app uses the anon key for reads where relevant and
the service-role key (server-only) for writes; the scanner worker always uses
the service-role key.

---

## Database structure

See [`database/schema.sql`](database/schema.sql). Three tables:

- **`tokens`** — one row per discovered tradable token (address, name,
  symbol, pair address, dex, creator, first-seen time, pair-created time).
- **`token_snapshots`** — append-only historical snapshots per token: price,
  liquidity, market cap, volume/buys/sells at multiple intervals, price
  changes, momentum score, opportunity score, signal. This is the data future
  versions will use to check "did this token pump, how much, how fast, did
  the signal work."
- **`scanner_status`** — a single row the scanner worker keeps updated:
  status (`LIVE` / `DEGRADED` / `OFFLINE`), last event time, last token
  discovered, counters, last error.

### Setup

1. Open your Supabase project.
2. Go to **SQL Editor**.
3. Paste the entire contents of `database/schema.sql`.
4. Run it.
5. Copy your project URL, anon key, and service role key into your `.env`.

---

## Scoring formula

**Opportunity Score (0–100)** — a deterministic ranking metric, weighted:

| Component               | Weight |
|--------------------------|--------|
| Volume Acceleration      | 25%    |
| Buy/Sell Pressure        | 20%    |
| Liquidity Quality        | 20%    |
| Price Momentum           | 20%    |
| Early Token Stage        | 15%    |

> The score is **not a probability**. The UI always displays it as
> `Opportunity Score: 86/100`, never as "86% chance."

If a component can't be computed (e.g. no volume baseline exists yet for
acceleration), it is **excluded** from the weighted average rather than
treated as zero — see `lib/analyzer/opportunity.js`.

**Signals** (`lib/analyzer/opportunity.js`, thresholds configurable via env):
`VERY_EARLY`, `EARLY`, `MOMENTUM`, `PUMPING`, `LOW_ACTIVITY`. A token that has
already spiked hard in price is classified `PUMPING` rather than rewarded as
"early" — the product goal is catching early signs of interest, not chasing
tokens that already ran (see spec principle: a token already +500% should not
automatically outrank a 10-minute-old token with healthy, growing activity).

---

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Safe for browser |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **Server only** — never expose to the browser |
| `SOLANA_RPC_URL` | yes | HTTP RPC endpoint |
| `SOLANA_WS_URL` | yes | WebSocket RPC endpoint |
| `DEXSCREENER_API_BASE_URL` | no | Defaults to `https://api.dexscreener.com` |
| `MARKET_POLL_INTERVAL_MS` | no | Default `10000` |
| `SCANNER_RECONNECT_DELAY_MS` | no | Default `5000` |
| `DEMO_MODE` | no | Must be `false` in production |

---

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in your values
npm run dev
```

Visit `http://localhost:3000`.

## Running the scanner

The scanner is a separate, long-running Node process — it is **not** part of
the Next.js app and must not be deployed as a Vercel serverless function.

```bash
npm run scanner
```

It connects to Solana, listens for pool/pair activity, confirms candidates
via DexScreener, writes discovered tokens + snapshots to Supabase, and keeps
`scanner_status` up to date. It reconnects automatically with exponential
backoff if the WebSocket drops, and falls back to conservative DexScreener
polling (never fake data) while degraded.

## Deploying the frontend (Vercel)

1. Push this repo to GitHub.
2. Import it in Vercel.
3. Set the environment variables from the table above in the Vercel project
   settings (Production + Preview as needed).
4. Deploy. `npm run build` must succeed — it's Vercel's default build command
   for Next.js.

## Deploying the scanner

The scanner needs a place that supports a persistent process — Vercel
functions time out and can't hold a WebSocket open. Reasonable free/low-cost
options: a small always-on VM, Railway, Fly.io, or a Render background
worker. Point it at the **same** Supabase project as the Vercel app (same
`SUPABASE_SERVICE_ROLE_KEY` and URL) and run `npm run scanner` as its start
command. The web app only reads from Supabase — it has no dependency on
where or how the scanner is hosted.

---

## API documentation

- `GET /api/tokens?minScore=&maxAge=&minLiquidity=&signal=&sort=&limit=` —
  latest discovered tokens joined with their latest snapshot.
- `GET /api/token/:address` — token info + latest snapshot + recent snapshot
  history (for the detail page and charts).
- `GET /api/scanner` — current scanner status (`LIVE`/`DEGRADED`/`OFFLINE`,
  counters, last error).
- `GET /api/health` — `{ success, database, dexscreener, scanner }` health
  check. Never exposes secrets.

---

## Tests

```bash
npm run test
```

Covers token normalization, volume/ratio calculations, buy/sell pressure,
momentum, opportunity scoring (including deterministic high-score/low-score
cases), signal classification, token age, and formatting utilities. Tests use
mocked/synthetic data — no live Solana or DexScreener connection required.

## Build

```bash
npm run lint
npm run test
npm run build
```

`npm run build` must succeed with no errors before deploying.

---

## Current limitations (V1)

Solana AI V1 does **not** yet analyze: smart money / wallet quality, token
security or rug risk, news, social sentiment, historical outcome-based
probability, or use machine learning. **Opportunity Score is an experimental
market-momentum ranking, not a prediction guarantee.**

## Troubleshooting

- **Scanner shows `OFFLINE` / dashboard says no tokens:** confirm the scanner
  process (`npm run scanner`) is actually running somewhere and has valid
  Supabase + Solana RPC credentials.
- **Scanner shows `DEGRADED`:** the WebSocket connection dropped and it's
  reconnecting with backoff; fallback polling is active in the meantime. If
  this persists, check your RPC provider's status/limits.
- **"Market data temporarily unavailable" on a token:** DexScreener didn't
  respond for that request; the last known snapshot is still shown. This is
  expected occasionally on free/public infrastructure.
- **Vercel build fails:** run `npm run build` locally first and fix errors
  there; make sure all required env vars are set in the Vercel project.

## Future roadmap

Documented only — **not implemented in V1**:

- **V2** — Smart Money Wallet Detection
- **V3** — Rug/Risk Detection
- **V4** — Whale Alerts
- **V5** — News + Social Signals
- **V6** — Historical Outcome Tracking
- **V7** — Probability Calibration
- **V8** — AI/ML Model
- **V9** — Telegram Alerts
- **V10** — Advanced ranking

The V1 architecture (normalized token shape, append-only snapshots, modular
`lib/` layout) is designed so these can be added without rewriting V1.

## License

MIT — see [`LICENSE`](LICENSE).
