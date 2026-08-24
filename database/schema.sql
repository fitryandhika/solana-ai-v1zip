-- ============================================================================
-- Solana AI V1 — Supabase schema (consolidated, includes migrations 002-007)
--
-- How to use:
--   1. Open your Supabase project.
--   2. Go to SQL Editor.
--   3. Paste this entire file.
--   4. Run it.
--   5. Configure your .env / .env.local with the project URL + keys.
--   6. Start the app.
--
-- This file is the single source of truth for a FRESH setup. If your
-- project was set up before migrations 002-007 existed, you don't need to
-- re-run this — your database already has these columns from running the
-- migration_00N_*.sql files directly. This file just keeps a from-scratch
-- setup in sync with where the schema actually is today.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- tokens: one row per discovered tradable token/pair
-- ----------------------------------------------------------------------------
create table if not exists tokens (
  id                uuid primary key default uuid_generate_v4(),
  address           text not null unique,
  name              text,
  symbol            text,
  pair_address      text,
  dex               text,
  creator           text,
  first_seen_at     timestamptz not null default now(),
  pair_created_at   timestamptz,
  image_url         text,

  -- Discovery context (migration 002)
  source                        text, -- 'blockchain' | 'trending'
  age_at_discovery_minutes      numeric,

  -- One-time rug-risk checks, performed at discovery (migration 002)
  mint_authority_revoked        boolean,
  freeze_authority_revoked      boolean,
  rug_check_at                  timestamptz,
  rug_check_error               text,
  top10_holder_pct              numeric,

  -- Social links, when DexScreener has them (migration 002)
  website_url                   text,
  twitter_url                   text,
  telegram_url                  text,

  -- Creator history snapshot at discovery time (migration 005)
  creator_prior_token_count               integer,
  creator_prior_rug_count                 integer,
  creator_prior_avg_price_change_pct_24h  numeric,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_tokens_address on tokens (address);
create index if not exists idx_tokens_first_seen_at on tokens (first_seen_at desc);
create index if not exists idx_tokens_source on tokens (source);
create index if not exists idx_tokens_creator on tokens (creator);

-- ----------------------------------------------------------------------------
-- token_snapshots: time-series market data + computed scores per token
-- ----------------------------------------------------------------------------
create table if not exists token_snapshots (
  id                  uuid primary key default uuid_generate_v4(),
  token_address       text not null references tokens (address) on delete cascade,
  timestamp           timestamptz not null default now(),

  price               numeric,
  liquidity           numeric,
  market_cap          numeric,

  volume_1m           numeric,
  volume_5m           numeric,
  volume_15m          numeric,

  -- Legacy/deprecated: historically mislabeled — always held 5-minute data
  -- under a "1m" name. Kept so old rows aren't orphaned; new rows use
  -- buys_5m/sells_5m instead. See migration_003_fix_buy_sell_naming.sql.
  buys_1m             integer,
  sells_1m            integer,
  buys_5m             integer,
  sells_5m            integer,

  buy_volume_1m       numeric,
  sell_volume_1m      numeric,

  price_change_1m     numeric,
  price_change_5m     numeric,
  price_change_15m    numeric,

  momentum_score      numeric,
  opportunity_score   numeric,

  signal              text,
  data_status         text not null default 'ok',

  source              text not null default 'dexscreener',

  -- Market-wide context per snapshot (migration 002)
  sol_price_usd       numeric,

  created_at          timestamptz not null default now()
);

create index if not exists idx_snapshots_token_address on token_snapshots (token_address);
create index if not exists idx_snapshots_timestamp on token_snapshots (timestamp desc);
create index if not exists idx_snapshots_opportunity_score on token_snapshots (opportunity_score desc);

-- ----------------------------------------------------------------------------
-- token_outcomes: the evaluation dataset (migration 004, extended in 007)
-- One row per token, denormalized so it can be queried on its own. Each
-- price_change_pct_<horizon> is null until that horizon is reached AND
-- computed — never "0% move". finalized_at is set once the 24h horizon is
-- computed; after that the row never changes again.
-- ----------------------------------------------------------------------------
create table if not exists token_outcomes (
  token_address             text primary key references tokens (address) on delete cascade,
  discovered_at             timestamptz not null,

  discovery_price           numeric,
  discovery_liquidity       numeric,
  discovery_market_cap      numeric,
  discovery_opportunity_score numeric,
  discovery_signal          text,

  price_change_pct_1m       numeric,
  price_change_pct_5m       numeric,
  price_change_pct_15m      numeric,
  price_change_pct_30m      numeric,
  price_change_pct_1h       numeric,
  price_change_pct_4h       numeric,
  price_change_pct_6h       numeric,
  price_change_pct_24h      numeric,

  liquidity_change_pct_1h   numeric,
  liquidity_change_pct_24h  numeric,

  is_rug_1h                 boolean,
  is_rug_24h                boolean,

  finalized_at              timestamptz,
  updated_at                timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

create index if not exists idx_outcomes_finalized_at on token_outcomes (finalized_at);
create index if not exists idx_outcomes_discovery_signal on token_outcomes (discovery_signal);

-- ----------------------------------------------------------------------------
-- scanner_status: SINGLETON status row for the background scanner.
-- The app always reads/writes the row with this exact fixed id (see
-- SCANNER_STATUS_ROW_ID in worker/scanner.js and app/api/scanner/route.js)
-- — never a randomly generated one. The seed below must match.
-- ----------------------------------------------------------------------------
create table if not exists scanner_status (
  id                          uuid primary key default uuid_generate_v4(),
  status                      text not null default 'OFFLINE', -- LIVE | DEGRADED | OFFLINE
  last_event_at               timestamptz,
  last_token_discovered_at    timestamptz,
  last_successful_api_call    timestamptz,
  tokens_discovered           integer not null default 0,
  tokens_analyzed             integer not null default 0,
  last_error                  text,
  updated_at                  timestamptz not null default now()
);

-- Seed the one singleton row with the FIXED id the app code expects.
-- Using uuid_generate_v4() here (a random id) would make the app's
-- fixed-id lookups always come back empty — this exact id must match
-- SCANNER_STATUS_ROW_ID in worker/scanner.js and app/api/scanner/route.js.
insert into scanner_status (id, status)
values ('00000000-0000-0000-0000-000000000001', 'OFFLINE')
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- updated_at trigger helper
-- ----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tokens_updated_at on tokens;
create trigger trg_tokens_updated_at
  before update on tokens
  for each row execute function set_updated_at();

drop trigger if exists trg_scanner_status_updated_at on scanner_status;
create trigger trg_scanner_status_updated_at
  before update on scanner_status
  for each row execute function set_updated_at();

drop trigger if exists trg_outcomes_updated_at on token_outcomes;
create trigger trg_outcomes_updated_at
  before update on token_outcomes
  for each row execute function set_updated_at();
