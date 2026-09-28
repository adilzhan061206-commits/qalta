-- Қалта: Supabase дерекқорын баптау.
-- Supabase → SQL Editor → New query → осы файлды толық қойып, Run басыңыз.

create table if not exists public.qalta_docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  path       text        not null,          -- "settings" немесе "m/2026-09"
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

-- Әр адам тек өз деректерін көреді және өзгертеді
alter table public.qalta_docs enable row level security;

drop policy if exists "own rows select" on public.qalta_docs;
drop policy if exists "own rows insert" on public.qalta_docs;
drop policy if exists "own rows update" on public.qalta_docs;
drop policy if exists "own rows delete" on public.qalta_docs;

create policy "own rows select" on public.qalta_docs for select to authenticated using (auth.uid() = user_id);
create policy "own rows insert" on public.qalta_docs for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows update" on public.qalta_docs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows delete" on public.qalta_docs for delete to authenticated using (auth.uid() = user_id);

-- Телефонда жазсаңыз, ноутта бірден көріну үшін (realtime)
do $$
begin
  alter publication supabase_realtime add table public.qalta_docs;
exception when duplicate_object then null;
end $$;
