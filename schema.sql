-- Go Bet Me: схема для Supabase (Postgres)
-- Запуск: Supabase → SQL Editor → вставить всё → Run
-- Все деньги здесь ненастоящие кредиты.

-- ---------- Таблицы ----------
create table profiles (
  nickname text primary key,
  balance  int  not null default 100 check (balance >= 0)   -- стартовые кредиты
);

create table challenges (
  id         uuid primary key default gen_random_uuid(),
  creator    text not null references profiles(nickname),
  exercise   text not null check (exercise in ('pushup','squat','plank')),
  target     int  not null check (target > 0),               -- повторы или секунды
  stake      int  not null check (stake > 0),                -- ставка создателя
  status     text not null default 'open'
             check (status in ('open','live','settled','cancelled')),
  success    boolean,                                        -- итог, null пока не рассчитан
  achieved   int,                                            -- сколько реально сделал
  created_at timestamptz not null default now()
);

create table bets (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  bettor       text not null references profiles(nickname),
  amount       int  not null check (amount > 0),             -- ставка ПРОТИВ
  created_at   timestamptz not null default now()
);

create index on bets(challenge_id);

-- ---------- Функции (вся логика денег в базе, атомарно) ----------

-- Профиль по нику: создаётся при первом входе
create or replace function ensure_profile(p_nick text)
returns int language plpgsql security definer set search_path = public as $$
declare bal int;
begin
  insert into profiles(nickname) values (p_nick) on conflict do nothing;
  select balance into bal from profiles where nickname = p_nick;
  return bal;
end $$;

-- Создать челлендж: ставка создателя замораживается (списывается сразу)
create or replace function create_challenge(p_creator text, p_exercise text, p_target int, p_stake int)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  update profiles set balance = balance - p_stake where nickname = p_creator;  -- упадёт, если не хватает
  insert into challenges(creator, exercise, target, stake)
    values (p_creator, p_exercise, p_target, p_stake)
    returning id into new_id;
  return new_id;
end $$;

-- Поставить против: сумма всех ставок против <= ставка создателя, кто раньше
create or replace function place_bet(p_challenge uuid, p_bettor text, p_amount int)
returns void language plpgsql security definer set search_path = public as $$
declare c challenges; taken int; free int;
begin
  select * into c from challenges where id = p_challenge for update;   -- блокировка от гонки
  if not found then raise exception 'Челлендж не найден'; end if;
  if c.status <> 'open' then raise exception 'Ставки закрыты'; end if;
  if p_bettor = c.creator then raise exception 'Нельзя ставить против себя'; end if;
  select coalesce(sum(amount), 0) into taken from bets where challenge_id = p_challenge;
  free := c.stake - taken;
  if p_amount > free then raise exception 'Осталось места на % кр.', free; end if;
  update profiles set balance = balance - p_amount where nickname = p_bettor;
  insert into bets(challenge_id, bettor, amount) values (p_challenge, p_bettor, p_amount);
end $$;

-- Старт: ставки закрываются
create or replace function start_challenge(p_challenge uuid)
returns void language sql security definer set search_path = public as $$
  update challenges set status = 'live' where id = p_challenge and status = 'open';
$$;

-- Расчёт. Комиссия приложения: 5% с ставок друзей (с выигрыша)
--   сделал:    создатель забирает свою ставку + ставки друзей - комиссия
--   не сделал: каждый друг получает свою ставку обратно + столько же из ставки создателя - комиссия;
--              создатель получает остаток (stake - сумма ставок против)
--   соло:      сделал = ставка возвращается, не сделал = ставка сгорает
create or replace function settle_challenge(p_challenge uuid, p_success boolean, p_achieved int)
returns void language plpgsql security definer set search_path = public as $$
declare c challenges; total int; b record; fee_rate numeric := 0.05;
begin
  select * into c from challenges where id = p_challenge for update;
  if not found then raise exception 'Челлендж не найден'; end if;
  if c.status not in ('open','live') then raise exception 'Уже рассчитан'; end if;

  select coalesce(sum(amount), 0) into total from bets where challenge_id = p_challenge;

  if p_success then
    update profiles
       set balance = balance + c.stake + total - floor(total * fee_rate)
     where nickname = c.creator;
  else
    update profiles set balance = balance + (c.stake - total) where nickname = c.creator;
    for b in select bettor, sum(amount) as amt from bets
              where challenge_id = p_challenge group by bettor loop
      update profiles
         set balance = balance + b.amt * 2 - floor(b.amt * fee_rate)
       where nickname = b.bettor;
    end loop;
  end if;

  update challenges set status = 'settled', success = p_success, achieved = p_achieved
   where id = p_challenge;
end $$;

-- Отмена (например, упал стрим): всем возврат
create or replace function cancel_challenge(p_challenge uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c challenges; b record;
begin
  select * into c from challenges where id = p_challenge for update;
  if not found or c.status not in ('open','live') then raise exception 'Нельзя отменить'; end if;
  update profiles set balance = balance + c.stake where nickname = c.creator;
  for b in select bettor, sum(amount) as amt from bets
            where challenge_id = p_challenge group by bettor loop
    update profiles set balance = balance + b.amt where nickname = b.bettor;
  end loop;
  update challenges set status = 'cancelled' where id = p_challenge;
end $$;

-- ---------- Безопасность ----------
-- Читать можно всем, писать напрямую нельзя: только через функции выше
alter table profiles   enable row level security;
alter table challenges enable row level security;
alter table bets       enable row level security;

create policy "read profiles"   on profiles   for select using (true);
create policy "read challenges" on challenges for select using (true);
create policy "read bets"       on bets       for select using (true);

-- ---------- Реалтайм: друзья видят ставки и статус вживую ----------
alter publication supabase_realtime add table challenges, bets;
