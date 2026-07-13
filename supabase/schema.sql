-- Packing system — Supabase schema
--
-- Run this once in your Supabase project's SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
--
-- Design notes:
--  * Passwords are hashed with pgcrypto (bcrypt) and never sent to the
--    client. Login/account management goes through the RPC functions
--    below rather than direct table access, so the public anon key
--    (which ships inside the deployed app's JS bundle) can never read
--    a password hash.
--  * `items` doubles as the packing log: packed_at/packed_by are null
--    until a packer confirms the item, at which point the same row
--    becomes both "packed" and "logged". There's no separate logs
--    table, so the two can't drift apart (this replaces an earlier
--    bug where logging and packing were two separate state updates
--    that could fire an inconsistent number of times).
--  * gates.closed_at is maintained by a trigger that recomputes from
--    the actual current row count on every items change, instead of
--    trusting a client's local view of "how many are left" — that
--    matters once multiple devices (web admin + packer APKs) can
--    write to the same gate concurrently.

create extension if not exists pgcrypto;

-- ACCOUNTS ------------------------------------------------------------

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'packer')),
  created_at timestamptz not null default now()
);

alter table accounts enable row level security;
-- Intentionally no policies here: nothing can read/write this table
-- directly with the anon key. All access is through the SECURITY
-- DEFINER functions below, and through the accounts_public view.

create or replace view accounts_public as
  select id, username, role, created_at from accounts;

grant select on accounts_public to anon;

-- search_path includes `extensions` because Supabase installs pgcrypto
-- there (not `public`), so crypt()/gen_salt() below would otherwise be
-- unresolvable even though the extension exists.
create or replace function login(p_username text, p_password text)
returns table (id uuid, username text, role text)
language sql security definer set search_path = public, extensions as $$
  select id, username, role
  from accounts
  where lower(username) = lower(p_username)
    and password_hash = crypt(p_password, password_hash);
$$;

grant execute on function login(text, text) to anon;

create or replace function create_account(p_username text, p_password text, p_role text)
returns table (id uuid, username text, role text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  return query
    insert into accounts (username, password_hash, role)
    values (p_username, crypt(p_password, gen_salt('bf')), p_role)
    returning accounts.id, accounts.username, accounts.role;
end;
$$;

grant execute on function create_account(text, text, text) to anon;

create or replace function set_account_role(p_id uuid, p_role text)
returns void
language sql security definer set search_path = public as $$
  update accounts set role = p_role where id = p_id;
$$;

grant execute on function set_account_role(uuid, text) to anon;

create or replace function remove_account(p_id uuid)
returns void
language sql security definer set search_path = public as $$
  delete from accounts where id = p_id;
$$;

grant execute on function remove_account(uuid) to anon;

-- GATES -----------------------------------------------------------------

create table if not exists gates (
  tracking text primary key,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table gates enable row level security;
create policy "gates readable by anyone" on gates for select using (true);
create policy "gates insertable by anyone" on gates for insert with check (true);
create policy "gates updatable by anyone" on gates for update using (true);

-- ITEMS -------------------------------------------------------------------

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  gate_tracking text not null references gates(tracking) on delete cascade,
  sku text not null default '',
  name text not null default '',
  qty integer not null default 0,
  image text not null default '',
  barcode text not null default '',
  packed_at timestamptz,
  packed_by text,
  created_at timestamptz not null default now()
);

create index if not exists items_gate_tracking_idx on items(gate_tracking);
create index if not exists items_packed_at_idx on items(packed_at);

alter table items enable row level security;
create policy "items readable by anyone" on items for select using (true);
create policy "items insertable by anyone" on items for insert with check (true);
create policy "items updatable by anyone" on items for update using (true);

create or replace function sync_gate_closed_at()
returns trigger language plpgsql as $$
declare
  v_gate text := coalesce(new.gate_tracking, old.gate_tracking);
  v_remaining int;
begin
  select count(*) into v_remaining from items
    where gate_tracking = v_gate and packed_at is null;

  if v_remaining = 0 then
    update gates set closed_at = now() where tracking = v_gate and closed_at is null;
  else
    update gates set closed_at = null where tracking = v_gate and closed_at is not null;
  end if;

  return null;
end;
$$;

drop trigger if exists items_sync_gate_closed_at on items;
create trigger items_sync_gate_closed_at
  after insert or update or delete on items
  for each row execute function sync_gate_closed_at();

-- Bulk-import gate rows from the admin "Gate upload" paste box in one
-- transaction: merges qty into an existing unpacked row with the same
-- sku+barcode, otherwise inserts a new item row. Creating a gate row
-- and inserting an unpacked item both make the sync trigger above
-- re-open a previously-closed gate automatically.
create or replace function import_gate_rows(p_rows jsonb)
returns table (imported int, skipped int)
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb;
  v_tracking text;
  v_sku text;
  v_name text;
  v_qty int;
  v_image text;
  v_barcode text;
  v_imported int := 0;
  v_existing_id uuid;
begin
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_tracking := trim(coalesce(v_row->>'tracking', ''));
    if v_tracking = '' then continue; end if;

    v_sku := coalesce(v_row->>'sku', '');
    v_name := coalesce(v_row->>'name', '');
    v_qty := coalesce((v_row->>'qty')::int, 0);
    v_image := coalesce(v_row->>'image', '');
    v_barcode := coalesce(v_row->>'barcode', '');

    insert into gates (tracking) values (v_tracking)
      on conflict (tracking) do nothing;

    select id into v_existing_id from items
      where gate_tracking = v_tracking and sku = v_sku and barcode = v_barcode
        and packed_at is null
      limit 1;

    if v_existing_id is not null then
      update items set qty = qty + v_qty where id = v_existing_id;
    else
      insert into items (gate_tracking, sku, name, qty, image, barcode)
        values (v_tracking, v_sku, v_name, v_qty, v_image, v_barcode);
    end if;

    v_imported := v_imported + 1;
  end loop;

  return query select v_imported, jsonb_array_length(p_rows) - v_imported;
end;
$$;

grant execute on function import_gate_rows(jsonb) to anon;

-- PACKER PRODUCTIVITY -------------------------------------------------
-- Per-packer stats for the Productivity dashboard, aggregated in the
-- database (a 15k-order day is far too many rows to count client-side).
-- Each gate packed in the window is classified by what was packed:
--   single           = 1 line with qty 1
--   single_multi_qty = 1 line with qty > 1
--   multi            = more than 1 line
-- A gate is attributed to whoever packed its most recent item (in
-- practice one packer packs a whole parcel, so this only matters in
-- rare hand-off cases).

create or replace function packer_stats(p_start timestamptz, p_end timestamptz)
returns table (
  packer text,
  total_gates bigint,
  single_gates bigint,
  single_multi_qty bigint,
  multi_gates bigint,
  total_lines bigint,
  total_qty bigint
)
language sql security definer set search_path = public as $$
  with packed as (
    select gate_tracking, coalesce(packed_by, 'unknown') as packed_by, qty, packed_at
    from items
    where packed_at >= p_start and packed_at < p_end
  ),
  gate_rollup as (
    select
      gate_tracking,
      count(*) as lines,
      sum(qty) as gate_qty,
      (array_agg(packed_by order by packed_at desc))[1] as gate_packer
    from packed
    group by gate_tracking
  )
  select
    gate_packer as packer,
    count(*) as total_gates,
    count(*) filter (where lines = 1 and gate_qty = 1) as single_gates,
    count(*) filter (where lines = 1 and gate_qty > 1) as single_multi_qty,
    count(*) filter (where lines > 1) as multi_gates,
    sum(lines) as total_lines,
    sum(gate_qty) as total_qty
  from gate_rollup
  group by gate_packer
  order by total_gates desc;
$$;

grant execute on function packer_stats(timestamptz, timestamptz) to anon;

-- REALTIME ----------------------------------------------------------------
-- Lets a gate uploaded on the web admin appear instantly on a packer's
-- device, and a packer's confirm reflect back on the admin dashboard.

alter publication supabase_realtime add table gates;
alter publication supabase_realtime add table items;

-- SEED DEMO ACCOUNTS --------------------------------------------------
-- Matches the accounts the app shipped with before Supabase (README).
-- Safe to re-run: does nothing if they already exist.

insert into accounts (username, password_hash, role) values
  ('admin', extensions.crypt('admin123', extensions.gen_salt('bf')), 'admin'),
  ('packer1', extensions.crypt('pack123', extensions.gen_salt('bf')), 'packer')
on conflict (username) do nothing;
