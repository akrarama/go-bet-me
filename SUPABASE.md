# Регистрация и сохранение кредитов через Supabase

Приложение размещается как статичный сайт GitHub Pages, поэтому база подключается через Supabase.

1. Создай проект на [supabase.com](https://supabase.com/) и открой **SQL Editor**.
2. Выполни SQL ниже.
3. В **Project Settings → API** скопируй Project URL и публичный anon/publishable key. Вставь их в `SUPABASE_URL` и `SUPABASE_ANON_KEY` в `src/config.js`.
4. В **Authentication → Sign In / Providers → Email** отключи **Confirm email**. Приложение использует только логин и пароль, адрес email пользователю не нужен; вход Supabase выполняет через внутренний адрес.
5. В **Authentication → URL Configuration** оставь Site URL на адресе опубликованного сайта `https://akrarama.github.io/go-bet-me/`.
6. Опубликуй обновлённый сайт. Пользователь создаёт аккаунт по логину и паролю.

```sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  credits numeric(12, 2) not null default 100 check (credits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "Create own profile" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
create policy "Update own credits" on public.profiles
  for update to authenticated using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
```

Каждый профиль привязан к `auth.users`; политики RLS не дают читать или менять чужие строки. Баланс загружается при входе и сохраняется после изменений, поэтому восстанавливается при следующем входе и на другом устройстве. Это демонстрационные кредиты: приложение сейчас считает баланс в браузере, поэтому система не подходит для реальных денег или призовых ставок. Для денежного баланса понадобится серверная логика транзакций.

Публичный anon key предназначен для браузера. Никогда не вставляй `service_role` key в `src/config.js` или другой файл сайта. Так как email не используется, восстановление пароля через почту сейчас недоступно — пользователю нужно помнить пароль.
