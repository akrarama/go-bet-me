import { SUPABASE_URL, SUPABASE_ANON_KEY, MONEY } from './config.js';

const START_BALANCE = MONEY.startBalance;
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Username/password gate backed by Supabase Auth's email/password provider. */
export async function requireAccount() {
  if (!configured) {
    showSetupMessage();
    return true;
  }
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const gate = document.querySelector('#account-gate');
  let signUp = false;
  let working = false;

  const render = (error = '') => {
    gate.hidden = false;
    gate.innerHTML = `<div class="account-card"><h1>Против</h1><p>${signUp ? 'Создай логин, чтобы сохранить кредиты.' : 'Войди, чтобы открыть свой аккаунт и баланс.'}</p>
      <form><input name="username" type="text" autocomplete="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_.-]{3,20}" placeholder="Логин (3–20 символов: латиница, цифры, . _ -)" required>
      <input name="password" type="password" minlength="6" autocomplete="${signUp ? 'new-password' : 'current-password'}" placeholder="Пароль, минимум 6 знаков" required>
      <button ${working ? 'disabled' : ''}>${working ? 'Подожди…' : signUp ? 'Зарегистрироваться' : 'Войти'}</button></form>
      <p class="muted">${signUp ? 'Укажи логин латиницей. Email не нужен. Восстановление пароля пока недоступно — сохрани его.' : ''}</p>
      <p class="account-error" role="status">${escapeHtml(error)}</p><button class="account-card__switch" data-switch>${signUp ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</button></div>`;
    gate.querySelector('[data-switch]').onclick = () => { signUp = !signUp; render(); };
    gate.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const username = String(form.get('username')).trim().toLowerCase();
      const password = String(form.get('password'));
      if (!/^[a-z0-9_.-]{3,20}$/.test(username)) return render('Логин: 3–20 символов, только латинские буквы, цифры, точка, дефис или _.');
      // Supabase Auth uses email/password internally. This reserved, non-deliverable address
      // gives the user a username-only experience; email confirmation must be disabled.
      const email = `${username}@accounts.go-bet-me.invalid`;
      working = true; render();
      const result = signUp
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      working = false;
      if (result.error) return render(result.error.message);
      if (signUp && !result.data.session) return render('В Supabase отключи подтверждение email (Authentication → Sign In / Providers → Email) и зарегистрируйся снова.');
      await startSession(result.data.user, signUp ? username : null);
    };
  };

  const startSession = async (user, newUsername = null) => {
    if (!user) return render('Не удалось определить аккаунт. Войди ещё раз.');
    let { data, error } = await supabase.from('profiles').select('credits, nickname').eq('id', user.id).maybeSingle();
    if (error) return render(`Ошибка базы: ${error.message}`);
    if (!data) {
      const created = await supabase.from('profiles').insert({ id: user.id, nickname: newUsername, credits: START_BALANCE }).select('credits, nickname').single();
      if (created.error) return render(`Не удалось создать профиль: ${created.error.message}`);
      data = created.data;
    }
    const credits = Number(data?.credits ?? START_BALANCE);
    const dir = globalThis.location?.pathname?.replace(/[^/]*$/, '') ?? '';
    const key = `${MONEY.storageKey}@${dir}:${user.id}`;
    globalThis.__accountStorageSuffix = user.id;
    try {
      const previous = JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify({ v: 1, cents: Math.round(credits * 100), history: Array.isArray(previous?.history) ? previous.history : [] }));
    } catch {}
    gate.hidden = true;
    gate.innerHTML = '';
    const badge = document.createElement('div');
    badge.className = 'account-user';
    badge.innerHTML = `<span class="chip">${escapeHtml(data?.nickname || newUsername || 'Аккаунт')}</span><button type="button">Выйти</button>`;
    document.querySelector('#stage').append(badge);
    badge.querySelector('button').onclick = async () => { await supabase.auth.signOut(); location.reload(); };
    let persistQueue = Promise.resolve();
    window.__creditsSync = (balance) => {
      const value = Math.max(0, Number(balance) || 0);
      persistQueue = persistQueue.then(async () => {
        const { error: saveError } = await supabase.from('profiles').update({ credits: value }).eq('id', user.id);
        if (saveError) console.warn('[credits sync]', saveError.message);
      }).catch((err) => console.warn('[credits sync]', err));
      return persistQueue;
    };
  };

  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) render(error.message);
    else if (session) await startSession(session.user);
    else render();
  } catch (err) {
    render(`Не удалось подключиться к Supabase: ${err.message}`);
  }
  return !gate.hidden;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function showSetupMessage() {
  const gate = document.querySelector('#account-gate');
  gate.hidden = false;
  gate.innerHTML = `<div class="account-card"><h1>Подключи базу</h1><p>Для регистрации и сохранения кредитов нужны URL и публичный ключ Supabase. Добавь их в <code>src/config.js</code> по инструкции в <code>SUPABASE.md</code>, затем обнови страницу.</p></div>`;
}
