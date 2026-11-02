import { getSettings, saveSettings, getAuth } from './store.js';
import { OAUTH } from './config.js';

export function normalizeServerUrl(raw) {
  const value = (raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Адрес сервера должен начинаться с https://');
  return url.origin;
}

async function api(path, { method = 'GET', body } = {}) {
  const settings = await getSettings();
  const origin = normalizeServerUrl(settings.serverUrl);
  if (!origin) throw new Error('В настройках не задан адрес сервера');
  if (!settings.syncKey) throw new Error('В настройках не задан ключ синхронизации');

  const res = await fetch(origin + path, {
    method,
    headers: {
      'X-Sync-Key': settings.syncKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Сервер вернул ${res.status}`);
  return data;
}

export async function pushConfig() {
  const settings = await getSettings();
  const auth = await getAuth();
  if (!settings.serverUrl || !settings.syncKey) throw new Error('Сервер не настроен');
  if (!auth?.refreshToken) throw new Error('Нет refresh token — переподключите Google');

  try {
    const data = await api('/api/account', {
      method: 'PUT',
      body: {
        refreshToken: auth.refreshToken,
        clientId: OAUTH.clientId,
        clientSecret: OAUTH.clientSecret,
        label: auth.label || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        reminders: settings.reminders,
        channels: {
          telegram: settings.telegram,
          discord: settings.discord,
        },
      },
    });
    await saveSettings({ lastSyncAt: Date.now(), lastSyncError: '' });
    return data;
  } catch (e) {
    await saveSettings({ lastSyncError: String(e.message || e) });
    throw e;
  }
}

export async function getServerStatus() {
  return api('/api/account');
}

export async function sendServerTest(channels) {
  return api('/api/test', { method: 'POST', body: { channels } });
}
