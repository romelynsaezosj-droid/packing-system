# Packing system

A warehouse packing app with role-based accounts: admins manage gate
imports, logs, and accounts; packers only see the packing screen.

## Data storage

All data — accounts, gates, items, and packing logs — lives in
Supabase, shared across every device signed in to it (the web app and
any Capacitor-wrapped APK). Only the current login session is kept
per-device, in `localStorage`.

### Setup

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. In the SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql).
   This creates the tables, the login/account-management functions, the
   trigger that keeps a gate's "closed" status correct as items are
   packed, and seeds the two demo accounts below.
3. Copy `.env.example` to `.env` and fill in your project's URL and
   anon key (Supabase dashboard → Settings → API).

### Why passwords go through RPC functions, not a table

The anon key Supabase uses for browser access ships inside the app's
JS bundle, so it's effectively public. Passwords are hashed
(`pgcrypto`/bcrypt) and the `accounts` table has no row-level-security
policies for it at all — login, account creation, role changes, and
removal all go through `SECURITY DEFINER` SQL functions
(`login`, `create_account`, `set_account_role`, `remove_account`) that
never return a password hash to the client. The Accounts admin screen
reads from an `accounts_public` view that excludes the password column
entirely.

Gates, items, and logs are intentionally left open to the anon key
(any signed-in device can read/write them) — this is a small internal
warehouse tool, not a multi-tenant product, so that trade-off is fine
for now. If that ever needs to change (e.g. packers shouldn't be able
to edit gates), that would mean moving to real per-user Supabase Auth
and scoping RLS policies by role.

## Run it locally

```bash
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173). Requires
the Supabase setup above — the app won't start without a valid `.env`.

## Build for production

```bash
npm run build
npm run preview   # preview the production build locally
```

`npm run build` outputs static files to `dist/` — you can deploy that
folder to any static host (Vercel, Netlify, S3, etc.).

## Demo accounts

| Username | Password  | Role   |
|----------|-----------|--------|
| admin    | admin123  | admin  |
| packer1  | pack123   | packer |

Seeded by `supabase/schema.sql`. Admins can add, remove, and change the
role of any account from the Accounts tab.
