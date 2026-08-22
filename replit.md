# Replit setup

## Web app

The Replit workflow `Start application` runs the existing Next.js dashboard on
port 5000:

```bash
npm run dev -- --hostname 0.0.0.0 --port 5000
```

The preview requires the Supabase environment values below. They are stored as
Replit Secrets and are never exposed by the health endpoint:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Before starting the app for the first time, run the complete
`database/schema.sql` file in the connected Supabase project's SQL Editor.

The remaining development defaults are configured as shared environment
variables for the public Solana RPC and DexScreener API. A dedicated Solana RPC
provider is recommended for sustained scanner operation.

## Scanner worker

The scanner is a separate persistent process and is not part of the web
preview. Start it separately when the Supabase schema and RPC credentials are
ready:

```bash
npm run scanner
```

## Checks

```bash
npm run test
npm run lint
npm run build
```

The dashboard can render without the scanner, but it will show `OFFLINE` until
the worker updates `scanner_status`. The app reports database errors directly
when the Supabase schema does not match the project schema.