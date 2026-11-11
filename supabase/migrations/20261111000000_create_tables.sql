-- liwan-desk database, step 1: the tables.
--
-- Every table here is locked at the end of this file: row level security is ON with no
-- policies, and the public roles (anon, authenticated) have no privileges at all. Only the
-- server key (the service role) can read or write, and that key lives only on the server.
--
-- Times are stored in UTC (timestamptz). Weekly free times are stored as the clinic's local
-- wall-clock time (Dubai), because "Tuesday 14:00" means 14:00 there all year.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.conversation_source as enum ('simulator', 'whatsapp');
create type public.conversation_status as enum ('bot', 'with_person', 'closed');
create type public.message_direction as enum ('in', 'out');
create type public.message_sender as enum ('customer', 'agent', 'receptionist');
create type public.appointment_status as enum ('booked', 'completed', 'cancelled', 'no_show');
create type public.handover_status as enum ('open', 'resolved');
create type public.handover_situation as enum (
  'emergency', 'complaint', 'wants_person', 'cancel_change', 'price_unlisted', 'booking_unclear', 'other'
);
-- What a row in the agent panel is: a plain step, Jev's answers, the clinic rules, or Claude's reply.
create type public.step_kind as enum ('step', 'classification', 'rules', 'writer');

create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Patients
-- ---------------------------------------------------------------------------

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,                                        -- international format, e.g. +971500000001
  preferred_language text not null default 'en' check (preferred_language in ('en', 'ar')),
  notes text,
  is_synthetic boolean not null default false,       -- made-up data, so it can always be found and removed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index patients_phone_key on public.patients (phone) where phone is not null;
create trigger patients_set_updated_at before update on public.patients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The clinic's weekly free times (what the agent offers when someone wants to book)
-- ---------------------------------------------------------------------------

create table public.weekly_free_times (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = Sunday ... 6 = Saturday
  start_time time not null,                                    -- clinic time (Dubai)
  duration_minutes integer not null default 30 check (duration_minutes > 0),
  created_at timestamptz not null default now(),
  unique (weekday, start_time)
);

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references public.patients (id) on delete set null,
  source public.conversation_source not null,       -- where it came from: the phone page now, WhatsApp later
  external_id text not null,                        -- the customer's WhatsApp number, or the phone page's session id
  customer_name text,
  status public.conversation_status not null default 'bot',   -- 'with_person' means the agent stays quiet
  language text check (language in ('en', 'ar')),
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index conversations_patient_id_idx on public.conversations (patient_id);
create index conversations_last_message_at_idx on public.conversations (last_message_at desc);
create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction public.message_direction not null,
  sender public.message_sender not null,
  body text not null,
  external_id text,                                  -- WhatsApp's own message id, used to ignore retries
  created_at timestamptz not null default now(),
  check (
    (direction = 'in' and sender = 'customer')
    or (direction = 'out' and sender in ('agent', 'receptionist'))
  )
);
create unique index messages_external_id_key on public.messages (external_id) where external_id is not null;
create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references public.patients (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  starts_at timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes > 0),
  status public.appointment_status not null default 'booked',
  treatment text,
  notes text,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (patient_id is not null or conversation_id is not null)
);
-- One booking per start time, so the same time can never be given to two people.
create unique index appointments_one_booking_per_time on public.appointments (starts_at) where status = 'booked';
create index appointments_patient_idx on public.appointments (patient_id);
create index appointments_starts_at_idx on public.appointments (starts_at);
create trigger appointments_set_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Hand-overs to a person
-- ---------------------------------------------------------------------------

create table public.handovers (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,   -- the customer message that caused it
  reason text not null,
  situation public.handover_situation not null default 'other',
  status public.handover_status not null default 'open',
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_at is not null))
);
create index handovers_status_idx on public.handovers (status, created_at);
create index handovers_conversation_idx on public.handovers (conversation_id);

-- ---------------------------------------------------------------------------
-- Every step the agent takes, with its cost: this is what the panel on the phone page shows
-- ---------------------------------------------------------------------------

create table public.agent_steps (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,   -- the customer message this run answered
  position smallint not null,                                                    -- order within the run
  kind public.step_kind not null default 'step',
  label text not null,
  detail text,
  engine text,                                      -- 'jev', 'claude', 'templates' or 'code'
  model text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  payload jsonb not null default '{}'::jsonb,       -- the answers with their confidence, the rule checks, the draft reply
  created_at timestamptz not null default now(),
  unique (message_id, position)
);
create index agent_steps_conversation_idx on public.agent_steps (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Lock everything: only the app's server key can reach these tables, never the public.
-- ---------------------------------------------------------------------------

alter table public.patients enable row level security;
alter table public.weekly_free_times enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.appointments enable row level security;
alter table public.handovers enable row level security;
alter table public.agent_steps enable row level security;
-- No policies on purpose: with row level security on and no policy, the public roles see nothing.
-- As a second lock they also get no privileges, now and for any table added later.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;
