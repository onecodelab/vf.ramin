-- Migration for Sosha Verifier tables in Supabase PostgreSQL

-- API keys table: minimal key-based auth for the Edge Function
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Example: insert initial key for "sosha-hops-web"
-- Replace 'YOUR_GENERATED_KEY_HERE' with a secure random string before running.
-- insert into public.api_keys (name, key)
-- values ('sosha-hops-web', 'YOUR_GENERATED_KEY_HERE');

-- Verified receipts table: records successful verifications at Sosha
create table if not exists public.verified_receipts (
  id uuid primary key default gen_random_uuid(),
  reference_number text not null,
  bank text not null,
  amount numeric,
  receiver_account text,
  verified_at timestamptz not null default now(),
  order_id text,
  branch_id text,
  verified_by text,
  manual_override boolean not null default false,
  constraint verified_receipts_unique_reference_bank unique (reference_number, bank)
);