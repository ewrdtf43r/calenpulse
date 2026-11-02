import { OAUTH_DEFAULTS } from './lib/config.js';

const $ = (selector) => document.querySelector(selector);

const state = { settings: null, auth: null, busy: false };

function send(type, data) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('Расширение не ответило — перезагрузите страницу'));
      if (response.ok) resolve(response.data);
      else reject(new Error(response.error));
    });
  });
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function randomKey() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function paintAuth() {
  const auth = state.auth;
  if (auth?.connected) {
    $('#auth-status').textContent = `Подключено: ${auth.label}`;
    $('#btn-connect').hidden = true;
    $('#btn-disconnect').hidden = false;
    $('#btn-reconnect').hidden = false;
    if (auth.hasRefreshToken === false) {
      $('#auth-status').textContent += ' (без refresh token — сервер 24/7 не сможет работать)';
    }
  } else {
    $('#auth-status').textContent = 'Google Календарь не подключён.';
    $('#btn-connect').hidden = false;
    $('#btn-disconnect').hidden = true;
    $('#btn-reconnect').hidden = true;
  }
}

function paint() {
  const s = state.settings;
  $('#server-url').value = s.serverUrl || '';
  $('#sync-key').value = s.syncKey || '';
  $('#local-notifications').checked = s.localNotifications;
  for (const input of document.querySelectorAll('#reminder-chips input')) {
    input.checked = s.reminders.includes(Number(input.value));
  }
  $('#tg-enabled').checked = s.telegram.enabled;
  $('#tg-token').value = s.telegram.botToken;
  $('#tg-chat').value = s.telegram.chatId;
  $('#dc-enabled').checked = s.discord.enabled;
  $('#dc-webhook').value = s.discord.webhookUrl;
  $('#oauth-client-id').value = s.oauth.clientId || OAUTH_DEFAULTS.clientId;
  $('#oauth-client-secret').value = s.oauth.clientSecret || '';

  const status = s.lastSyncError
    ? `Последняя синхронизация не удалась: ${s.lastSyncError}`
    : s.lastSyncAt
      ? `Синхронизировано ${new Date(s.lastSyncAt).toLocaleString('ru-RU')}`
      : 'Сервер ещё не синхронизировался.';
  $('#server-status').textContent = status;
}

function readForm() {
  const reminders = [...document.querySelectorAll('#reminder-chips input:checked')]
    .map((input) => Number(input.value))
    .sort((a, b) => b - a);
  return {
    serverUrl: $('#server-url').value.trim().replace(/\/+$/, ''),
    syncKey: $('#sync-key').value.trim(),
    localNotifications: $('#local-notifications').checked,
    reminders,
    oauth: {
      clientId: $('#oauth-client-id').value.trim(),
      clientSecret: $('#oauth-client-secret').value.trim(),
    },
    telegram: {
      enabled: $('#tg-enabled').checked,
      botToken: $('#tg-token').value.trim(),
      chatId: $('#tg-chat').value.trim(),
    },
    discord: {
      enabled: $('#dc-enabled').checked,
      webhookUrl: $('#dc-webhook').value.trim(),
    },
  };
}

function validate(settings) {
  if (settings.serverUrl) {
    let url;
    try {
      url = new URL(settings.serverUrl);
    } catch {
      throw new Error('Адрес сервера указан неверно');
    }
    if (url.protocol !== 'https:') throw new Error('Адрес сервера должен начинаться с https://');
  }
  if (settings.syncKey && settings.syncKey.length < 24) {
    throw new Error('Ключ синхронизации короче 24 символов');
  }
  if (settings.serverUrl && !settings.syncKey) {
    throw new Error('Заполните ключ синхронизации');
  }
  if (!settings.reminders.length) {
    throw new Error('Отметьте хотя бы один интервал напоминания');
  }
  if (settings.telegram.enabled && (!settings.telegram.botToken || !settings.telegram.chatId)) {
    throw new Error('Для Telegram заполните токен бота и chat id');
  }
  if (settings.discord.enabled) {
    let url;
    try {
      url = new URL(settings.discord.webhookUrl);
    } catch {
      throw new Error('Discord webhook URL указан неверно');
    }
    const host = url.hostname.replace(/^(ptb|canary)\./, '');
    if (!host.endsWith('discord.com') && !host.endsWith('discordapp.com')) {
      throw new Error('Discord webhook должен быть с домена discord.com');
    }
    if (!url.pathname.startsWith('/api/webhooks/')) {
      throw new Error('Discord webhook URL должен содержать /api/webhooks/');
    }
  }
}

async function save({ quiet = false } = {}) {
  const payload = readForm();
  validate(payload);
  const previousClientId = state.settings.oauth.clientId || OAUTH_DEFAULTS.clientId;
  state.settings = await send('settings:save', payload);
  paint();
  if (!quiet) {
    const nextClientId = payload.oauth.clientId || OAUTH_DEFAULTS.clientId;
    toast(
      nextClientId !== previousClientId
        ? 'Client ID изменён — нажмите «Обновить доступ»'
        : 'Настройки сохранены'
    );
  }
  return state.settings;
}

async function ensureServerPermission(origin) {
  const origins = [`${origin}/*`];
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error('Без доступа к адресу сервера синхронизация невозможна');
}

async function syncNow() {
  const payload = readForm();
  validate(payload);
  if (!payload.serverUrl) throw new Error('Укажите адрес сервера');
  if (!state.auth?.connected) throw new Error('Сначала подключите Google Календарь');
  const origin = new URL(payload.serverUrl).origin;
  await ensureServerPermission(origin);
  state.settings = await send('settings:save', payload);
  await send('server:sync');
  await send('settings:get').then((s) => { state.settings = s; });
  paint();
  toast('Конфигурация отправлена на сервер');
}

async function testChannel(channel) {
  await syncNow();
  const result = await send('server:test', { channels: [channel] });
  const names = { telegram: 'Telegram', discord: 'Discord' };
  if (result.errors?.length) {
    toast(`Отправлено: ${result.sent.join(', ')}. Ошибки: ${result.errors.join('; ')}`, true);
  } else {
    toast(`Тестовое сообщение отправлено: ${names[channel]}`);
  }
}

async function withBusy(button, action) {
  if (state.busy) return;
  state.busy = true;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Подождите…';
  try {
    await action();
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
    state.busy = false;
  }
}

async function init() {
  const redirectUri = chrome.identity.getRedirectURL();
  $('#redirect-uri').textContent = redirectUri;
  $('#btn-copy-redirect').addEventListener('click', async () => {
    await navigator.clipboard.writeText(redirectUri);
    toast('Redirect URI скопирован');
  });

  for (const id of ['#oauth-client-id', '#oauth-client-secret']) {
    $(id).addEventListener('change', () => {
      save({ quiet: true }).catch(() => {});
    });
  }

  state.settings = await send('settings:get');
  if (!state.settings.syncKey) state.settings.syncKey = randomKey();
  state.auth = await send('auth:status');
  paint();
  paintAuth();

  $('#btn-connect').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      await save({ quiet: true });
      const result = await send('auth:connect');
      state.auth = await send('auth:status');
      paintAuth();
      toast(result.syncError ? `Google подключён, но сервер: ${result.syncError}` : 'Google Календарь подключён');
    })
  );

  $('#btn-disconnect').addEventListener('click', async () => {
    if (!confirm('Отключить Google Календарь? Напоминания в Telegram и Discord тоже перестанут приходить.')) return;
    await send('auth:disconnect');
    state.auth = await send('auth:status');
    paintAuth();
    toast('Google Календарь отключён');
  });

  $('#btn-reconnect').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      await save({ quiet: true });
      await send('auth:connect');
      state.auth = await send('auth:status');
      paintAuth();
      toast('Доступ к Google обновлён');
    })
  );

  $('#btn-test-browser').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      await save({ quiet: true });
      const result = await send('notify:test');
      toast(
        result.listed
          ? 'Уведомление создано. Если баннера нет — проверьте Windows и центр уведомлений (Win+A)'
          : 'Windows не принял уведомление — проверьте настройки уведомлений Edge'
      );
    })
  );

  $('#btn-gen-key').addEventListener('click', () => {
    $('#sync-key').value = randomKey();
  });

  $('#btn-save').addEventListener('click', (e) =>
    withBusy(e.currentTarget, () => save())
  );

  $('#btn-sync').addEventListener('click', (e) =>
    withBusy(e.currentTarget, () => syncNow())
  );

  $('#btn-test-server').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      await syncNow();
      const result = await send('server:test', { channels: ['telegram', 'discord'] });
      if (result.errors?.length) {
        toast(`Отправлено: ${result.sent.join(', ') || 'ничего'}. Ошибки: ${result.errors.join('; ')}`, true);
      } else {
        toast('Тест отправлен во включённые каналы');
      }
    })
  );

  $('#btn-test-telegram').addEventListener('click', (e) =>
    withBusy(e.currentTarget, () => testChannel('telegram'))
  );

  $('#btn-test-discord').addEventListener('click', (e) =>
    withBusy(e.currentTarget, () => testChannel('discord'))
  );
}

init().catch((e) => {
  $('#auth-status').textContent = e.message;
  toast(e.message, true);
});
