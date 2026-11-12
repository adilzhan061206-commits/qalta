-- Қалта: Supabase дерекқорын баптау.
-- Supabase → SQL Editor → New query → осы файлды толық қойып, Run басыңыз.

create table if not exists public.qalta_docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  path       text        not null,          -- "settings" немесе "m/2026-09"
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

-- Кірген қолданушыларға кесте ашық (бірақ төмендегі RLS тек өз жолдарын береді)
grant select, insert, update, delete on public.qalta_docs to authenticated;
revoke all on public.qalta_docs from anon;

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

-- ============================================================
-- Apple Pay: iPhone «Команды» → «Транзакция» автоматтандыруы
-- төлем жасалған сәтте qalta_pay функциясын шақырады, ол төлемді
-- qalta_inbox кестесіне салады. Қосымша ашылғанда оларды шығын етіп жазады.
-- (Бұл бөлім бұрын орнатылған болса, қайта іске қоса беруге болады.)
-- ============================================================
create table if not exists public.qalta_tokens (
  token   text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade
);
grant select, insert, delete on public.qalta_tokens to authenticated;
revoke all on public.qalta_tokens from anon;
alter table public.qalta_tokens enable row level security;
drop policy if exists "own tokens" on public.qalta_tokens;
create policy "own tokens" on public.qalta_tokens for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.qalta_inbox (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  amount     numeric not null,
  merchant   text,
  card       text,
  raw        text,
  created_at timestamptz not null default now()
);
grant select, delete on public.qalta_inbox to authenticated;
revoke all on public.qalta_inbox from anon;
alter table public.qalta_inbox enable row level security;
drop policy if exists "own inbox select" on public.qalta_inbox;
drop policy if exists "own inbox delete" on public.qalta_inbox;
create policy "own inbox select" on public.qalta_inbox for select to authenticated using (auth.uid() = user_id);
create policy "own inbox delete" on public.qalta_inbox for delete to authenticated using (auth.uid() = user_id);

-- Сома iPhone-нан мәтін болып келеді: "1 250,50 ₸", "₸1 250", "1,250.50" — бәрін санға айналдырамыз
create or replace function public.qalta_pay(token text, amount text, merchant text default '', card text default '')
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid; m text; s text; v numeric; rest text;
begin
  select t.user_id into uid from public.qalta_tokens t where t.token = qalta_pay.token;
  if uid is null then raise exception 'Қалта: кілт дұрыс емес'; end if;
  -- iPhone sometimes puts Amount, Merchant and Card into one field ("₸1 400,00Ip NangoKaspi Gold"):
  -- the first number is the amount, the text left over becomes the merchant.
  m := substring(coalesce(amount, '') from '[0-9][0-9 \u00a0\u202f.,]*[0-9]|[0-9]');
  s := regexp_replace(coalesce(m, ''), '[^0-9,.]', '', 'g');
  if position(',' in s) > 0 and position('.' in s) > 0 then
    if position(',' in s) < position('.' in s) then s := replace(s, ',', ''); else s := replace(replace(s, '.', ''), ',', '.'); end if;
  elsif s ~ ',[0-9]{1,2}$' then s := replace(s, ',', '.');
  elsif s ~ '\.[0-9]{3}$' then s := replace(s, '.', '');
  else s := replace(s, ',', '');
  end if;
  v := nullif(s, '')::numeric;
  if v is null or v <= 0 then raise exception 'Қалта: сома танылмады (%)', amount; end if;
  rest := btrim(regexp_replace(replace(coalesce(amount, ''), coalesce(m, ''), ''), '[₸$€₽£¥]|\m(KZT|USD|EUR|RUB)\M', '', 'g'));
  if coalesce(btrim(merchant), '') = '' and rest <> '' then merchant := rest; end if;
  insert into public.qalta_inbox (user_id, amount, merchant, card, raw) values (uid, v, left(merchant, 80), left(card, 60), left(amount, 80));
  return 'ok';
end $$;
revoke all on function public.qalta_pay(text, text, text, text) from public;
grant execute on function public.qalta_pay(text, text, text, text) to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.qalta_inbox;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- Күнделікті еске салу (Web Push). Сервер жағы: Supabase Edge Function
-- «qalta-remind» (сағат сайын pg_cron шақырады), VAPID кілттері мен
-- cron құпиясы Vault-та: qalta_vapid_public, qalta_vapid_private, qalta_cron_secret.
-- ============================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;
create table if not exists public.qalta_push (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  hour       int  not null default 20 check (hour between 0 and 23),
  tz_min     int  not null default 300,
  lang       text not null default 'kk',
  last_sent  date,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.qalta_push to authenticated;
revoke all on public.qalta_push from anon;
alter table public.qalta_push enable row level security;
drop policy if exists "own push" on public.qalta_push;
create policy "own push" on public.qalta_push for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create or replace function public.qalta_push_secret(secret_name text)
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name and name like 'qalta_%' limit 1
$$;
revoke all on function public.qalta_push_secret(text) from public, anon, authenticated;
grant execute on function public.qalta_push_secret(text) to service_role;
-- cron (бір рет):
-- select cron.schedule('qalta-remind', '0 * * * *', $job$ select net.http_post(
--   url := 'https://<project>.supabase.co/functions/v1/qalta-remind',
--   headers := jsonb_build_object('Content-Type','application/json','x-qalta-cron', public.qalta_push_secret('qalta_cron_secret')),
--   body := '{}'::jsonb, timeout_milliseconds := 30000) $job$);
