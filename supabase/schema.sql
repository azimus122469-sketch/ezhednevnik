-- Ежедневник: схема базы для нового проекта Supabase.
-- Запусти целиком в Supabase: SQL Editor -> New query -> вставить -> Run.
-- Скрипт можно запускать повторно: уже созданное не пересоздаётся.

create extension if not exists pgcrypto with schema extensions;

/* ---------- таблицы ---------- */

create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id),
  date       date not null,
  col        text not null check (col in ('in','real','byt','lich','auto','cout','cin','self')),
  amount     numeric not null check (amount >= 0),
  cur        text not null default 'UZS' check (cur in ('UZS','USD')),
  note       text default '',
  created_at timestamptz not null default now(),
  wallet     text not null default 'cash_uzs' check (wallet in ('cash_uzs','card_uzs','cash_usd','card_usd')),
  source     text not null default 'user' check (source in ('user','ai')),
  updated_at timestamptz not null default now(),
  conv_id    uuid,
  rate       numeric,
  book_rate  numeric check (book_rate is null or book_rate > 0)
);
comment on column public.entries.book_rate is 'Учётный курс (сум за $1) на момент обмена; нужен для курсовой разницы.';

create table if not exists public.settings (
  user_id        uuid primary key default auth.uid() references auth.users(id),
  start_amount   numeric not null default 0,
  start_cur      text not null default 'USD',
  base_cur       text not null default 'USD',
  rate           numeric not null default 12600,
  checks         jsonb not null default '{}'::jsonb,
  starts         jsonb not null default '{}'::jsonb,
  notify_time    text not null default '21:00',
  rate_source    text not null default 'cbu',
  pay_pct        numeric not null default 10,
  pay_base       text not null default 'all' check (pay_base in ('all','real')),
  ai_model       text not null default 'luna' check (ai_model in ('luna','terra')),
  ai_daily_limit numeric not null default 1 check (ai_daily_limit >= 0)
);

create table if not exists public.goals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id),
  title      text not null,
  due        date,
  done       boolean not null default false,
  notify     boolean not null default true,
  source     text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.debts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id),
  kind       text not null check (kind in ('owe','owed')),
  person     text not null,
  amount     numeric not null check (amount > 0),
  cur        text not null default 'UZS' check (cur in ('UZS','USD')),
  paid       numeric not null default 0 check (paid >= 0),
  due        date,
  note       text not null default '',
  source     text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.goal_steps (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id),
  goal_id    uuid references public.goals(id),
  debt_id    uuid references public.debts(id),
  title      text not null,
  amount     numeric check (amount is null or amount >= 0),
  cur        text check (cur is null or cur in ('UZS','USD')),
  due        date,
  done       boolean not null default false,
  done_at    timestamptz,
  pos        integer not null default 0,
  source     text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id),
  name         text not null default 'Помощник',
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create table if not exists public.ai_actions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id),
  token_id   uuid references public.ai_tokens(id),
  summary    text not null,
  ops        jsonb not null,
  status     text not null default 'pending' check (status in ('pending','approved','rejected','failed')),
  error      text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.ai_chat (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id),
  role       text not null check (role in ('user','assistant')),
  content    text not null check (length(content) between 1 and 8000),
  action_id  uuid references public.ai_actions(id),
  created_at timestamptz not null default now()
);

create table if not exists public.ai_usage (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id),
  created_at       timestamptz not null default now(),
  model            text not null,
  input_tokens     integer,
  cached_tokens    integer,
  output_tokens    integer,
  reasoning_tokens integer,
  calls            integer not null default 1,
  cost_usd         numeric
);

/* ---------- индексы ---------- */
create index if not exists entries_user_date      on public.entries (user_id, date);
create index if not exists entries_conv           on public.entries (conv_id) where conv_id is not null;
create index if not exists goals_user_due         on public.goals (user_id, due);
create index if not exists debts_user             on public.debts (user_id, created_at);
create index if not exists goal_steps_goal        on public.goal_steps (goal_id, pos);
create index if not exists goal_steps_debt_id_idx on public.goal_steps (debt_id);
create index if not exists ai_actions_user_status on public.ai_actions (user_id, status, created_at desc);
create index if not exists ai_chat_user_time      on public.ai_chat (user_id, created_at desc);
create index if not exists ai_usage_user_time     on public.ai_usage (user_id, created_at desc);

/* ---------- защита строк: каждый видит только своё ---------- */
alter table public.entries     enable row level security;
alter table public.settings    enable row level security;
alter table public.goals       enable row level security;
alter table public.debts       enable row level security;
alter table public.goal_steps  enable row level security;
alter table public.ai_tokens   enable row level security;
alter table public.ai_actions  enable row level security;
alter table public.ai_chat     enable row level security;
alter table public.ai_usage    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['entries','settings','goals','debts','goal_steps'] loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='own '||t) then
      execute format('create policy %I on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', 'own '||t, t);
    end if;
  end loop;
end $$;

-- ИИ-таблицы: владелец только читает; записи создаёт сервер (ключ service_role) и функции ниже.
drop policy if exists "own ai actions read" on public.ai_actions;
create policy "own ai actions read" on public.ai_actions for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own ai tokens read" on public.ai_tokens;
create policy "own ai tokens read" on public.ai_tokens for select to authenticated using (auth.uid() = user_id);
drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own" on public.ai_usage for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own chat read" on public.ai_chat;
create policy "own chat read" on public.ai_chat for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own chat user insert" on public.ai_chat;
create policy "own chat user insert" on public.ai_chat for insert to authenticated with check (auth.uid() = user_id and role = 'user');

/* ---------- функции ---------- */

-- записи, внесённые помощником, получают точное время создания (для порядка в ленте)
create or replace function public.ai_entry_clock() returns trigger
language plpgsql set search_path to '' as $$
begin
  if new.source = 'ai' then new.created_at := clock_timestamp(); end if;
  return new;
end $$;
drop trigger if exists ai_entry_clock on public.entries;
create trigger ai_entry_clock before insert on public.entries for each row execute function public.ai_entry_clock();

create or replace function public.ai_create_token(p_name text default 'Помощник') returns text
language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare t text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  t := 'ezh_' || encode(gen_random_bytes(24), 'hex');
  insert into public.ai_tokens(user_id, name, token_hash)
  values (auth.uid(), coalesce(nullif(trim(p_name), ''), 'Помощник'), encode(digest(t, 'sha256'), 'hex'));
  return t;
end $$;

create or replace function public.ai_revoke_token(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.ai_tokens set revoked_at = now()
  where id = p_id and user_id = auth.uid() and revoked_at is null;
end $$;

-- владелец одобряет или отклоняет предложение помощника; выполняется только от его имени
create or replace function public.ai_decide(p_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid := auth.uid();
  a public.ai_actions%rowtype;
  o jsonb; r jsonb; n int := 0; c int;
  v_t timestamptz := clock_timestamp();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into a from public.ai_actions
   where id = p_id and user_id = v_uid and status = 'pending' for update;
  if not found then raise exception 'предложение не найдено или уже обработано'; end if;

  if not p_approve then
    update public.ai_actions set status = 'rejected', decided_at = now() where id = p_id;
    return jsonb_build_object('status', 'rejected');
  end if;

  begin
    for o in select * from jsonb_array_elements(a.ops) loop
      r := coalesce(o->'row', '{}'::jsonb);
      if o->>'table' = 'entries' and o->>'op' = 'insert' then
        insert into public.entries(id, user_id, date, col, amount, cur, wallet, note, source, conv_id, rate, book_rate, created_at, updated_at)
        values (coalesce(nullif(o->>'id','')::uuid, gen_random_uuid()), v_uid,
                (r->>'date')::date, r->>'col', (r->>'amount')::numeric,
                coalesce(r->>'cur','UZS'), coalesce(r->>'wallet','cash_uzs'), coalesce(r->>'note',''),
                'ai', nullif(r->>'conv_id','')::uuid, nullif(r->>'rate','')::numeric, nullif(r->>'book_rate','')::numeric,
                v_t + make_interval(secs => n / 1000.0), v_t + make_interval(secs => n / 1000.0));
      elsif o->>'table' = 'entries' and o->>'op' = 'update' then
        update public.entries set
          date = case when r ? 'date' then (r->>'date')::date else date end,
          col = case when r ? 'col' then r->>'col' else col end,
          amount = case when r ? 'amount' then (r->>'amount')::numeric else amount end,
          cur = case when r ? 'cur' then r->>'cur' else cur end,
          wallet = case when r ? 'wallet' then r->>'wallet' else wallet end,
          note = case when r ? 'note' then r->>'note' else note end,
          rate = case when r ? 'rate' then nullif(r->>'rate','')::numeric else rate end,
          book_rate = case when r ? 'book_rate' then nullif(r->>'book_rate','')::numeric else book_rate end,
          source = 'ai', updated_at = now()
        where id = (o->>'id')::uuid and user_id = v_uid;
        get diagnostics c = row_count;
        if c = 0 then raise exception 'запись % не найдена', o->>'id'; end if;
      elsif o->>'table' = 'entries' and o->>'op' = 'delete' then
        delete from public.entries where id = (o->>'id')::uuid and user_id = v_uid;
        get diagnostics c = row_count;
        if c = 0 then raise exception 'запись % не найдена', o->>'id'; end if;
      elsif o->>'table' = 'goals' and o->>'op' = 'insert' then
        insert into public.goals(id, user_id, title, due, done, notify, source)
        values (coalesce(nullif(o->>'id','')::uuid, gen_random_uuid()), v_uid, r->>'title',
                nullif(r->>'due','')::date, coalesce((r->>'done')::boolean, false),
                coalesce((r->>'notify')::boolean, true), 'ai');
      elsif o->>'table' = 'goals' and o->>'op' = 'update' then
        update public.goals set
          title = case when r ? 'title' then r->>'title' else title end,
          due = case when r ? 'due' then nullif(r->>'due','')::date else due end,
          done = case when r ? 'done' then (r->>'done')::boolean else done end,
          notify = case when r ? 'notify' then (r->>'notify')::boolean else notify end,
          source = 'ai', updated_at = now()
        where id = (o->>'id')::uuid and user_id = v_uid;
        get diagnostics c = row_count;
        if c = 0 then raise exception 'цель % не найдена', o->>'id'; end if;
      elsif o->>'table' = 'goals' and o->>'op' = 'delete' then
        delete from public.goals where id = (o->>'id')::uuid and user_id = v_uid;
        get diagnostics c = row_count;
        if c = 0 then raise exception 'цель % не найдена', o->>'id'; end if;
      elsif o->>'table' = 'settings' and o->>'op' = 'update' then
        update public.settings set
          starts = case when r ? 'starts' then r->'starts' else starts end,
          base_cur = case when r ? 'base_cur' then r->>'base_cur' else base_cur end,
          rate = case when r ? 'rate' then (r->>'rate')::numeric else rate end,
          rate_source = case when r ? 'rate_source' then r->>'rate_source' else rate_source end,
          notify_time = case when r ? 'notify_time' then r->>'notify_time' else notify_time end,
          pay_pct = case when r ? 'pay_pct' then (r->>'pay_pct')::numeric else pay_pct end,
          pay_base = case when r ? 'pay_base' then r->>'pay_base' else pay_base end
        where user_id = v_uid;
        get diagnostics c = row_count;
        if c = 0 then raise exception 'настройки не найдены'; end if;
      else
        raise exception 'неизвестная операция: % %', o->>'op', o->>'table';
      end if;
      n := n + 1;
    end loop;
  exception when others then
    update public.ai_actions set status = 'failed', error = sqlerrm, decided_at = now() where id = p_id;
    return jsonb_build_object('status', 'failed', 'error', sqlerrm);
  end;

  update public.ai_actions set status = 'approved', decided_at = now() where id = p_id;
  return jsonb_build_object('status', 'approved', 'ops', n);
end $$;

-- вызывать функции может только вошедший пользователь
revoke execute on function public.ai_create_token(text) from public, anon;
revoke execute on function public.ai_revoke_token(uuid) from public, anon;
revoke execute on function public.ai_decide(uuid, boolean) from public, anon;
grant  execute on function public.ai_create_token(text) to authenticated;
grant  execute on function public.ai_revoke_token(uuid) to authenticated;
grant  execute on function public.ai_decide(uuid, boolean) to authenticated;
