-- Ежедневник, обновление базы. Выполнить один раз в SQL Editor Supabase.

-- 1. Кошелёк у каждой записи
alter table entries add column if not exists wallet text not null default 'cash_uzs';
alter table entries drop constraint if exists entries_wallet_check;
alter table entries add constraint entries_wallet_check
  check (wallet in ('cash_uzs','card_uzs','cash_usd','card_usd'));

-- 2. Кто внёс запись: сам или помощник
alter table entries add column if not exists source text not null default 'user';
alter table entries drop constraint if exists entries_source_check;
alter table entries add constraint entries_source_check
  check (source in ('user','ai'));

-- 3. Время последней правки
alter table entries add column if not exists updated_at timestamptz not null default now();

-- 4. Настройки: стартовые остатки по кошелькам, время напоминания, источник курса
alter table settings add column if not exists starts jsonb not null default '{}'::jsonb;
alter table settings add column if not exists notify_time text not null default '21:00';
alter table settings add column if not exists rate_source text not null default 'cbu';

-- 5. Вторая тетрадь: цели
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  due date,
  done boolean not null default false,
  notify boolean not null default true,
  source text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table goals enable row level security;

drop policy if exists "own goals" on goals;
create policy "own goals" on goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists goals_user_due on goals (user_id, due);
