-- ============================================================================
-- Solana AI V1 — Supabase schema
--
-- How to use:
--   1. Open your Supabase project.
--   2. Go to SQL Editor.
--   3. Paste this entire file.
--   4. Run it.
--   5. Configure your .env / .env.local with the project URL + keys.
--   6. Start the app.
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
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_tokens_address on tokens (address);
create index if not exists idx_tokens_first_seen_at on tokens (first_seen_at desc);

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

  buys_1m             integer,
  sells_1m            integer,

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

  created_at          timestamptz not null default now()
);

create index if not exists idx_snapshots_token_address on token_snapshots (token_address);
create index if not exists idx_snapshots_timestamp on token_snapshots (timestamp desc);
create index if not exists idx_snapshots_opportunity_score on token_snapshots (opportunity_score desc);

-- ----------------------------------------------------------------------------
-- scanner_status: single/rolling status row(s) for the background scanner
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

-- Seed a single status row the scanner will update in place.
insert into scanner_status (status)
select 'OFFLINE'
where not exists (select 1 from scanner_status);

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
