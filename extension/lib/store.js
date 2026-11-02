const DEFAULTS = {
  serverUrl: '',
  syncKey: '',
  localNotifications: true,
  reminders: [60, 10],
  oauth: { clientId: '', clientSecret: '' },
  telegram: { enabled: false, botToken: '', chatId: '' },
  discord: { enabled: false, webhookUrl: '' },
  lastSyncAt: 0,
  lastSyncError: '',
};

function mergeSettings(stored = {}) {
  return {
    ...DEFAULTS,
    ...stored,
    oauth: { ...DEFAULTS.oauth, ...(stored.oauth || {}) },
    telegram: { ...DEFAULTS.telegram, ...(stored.telegram || {}) },
    discord: { ...DEFAULTS.discord, ...(stored.discord || {}) },
    reminders: Array.isArray(stored.reminders) ? stored.reminders : DEFAULTS.reminders,
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth || null;
}

export async function setAuth(auth) {
  await chrome.storage.local.set({ auth });
}

export async function clearAuth() {
  await chrome.storage.local.remove('auth');
}

export async function getSentMap() {
  const { sent } = await chrome.storage.local.get('sent');
  return sent || {};
}

export async function saveSentMap(map) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const pruned = {};
  for (const [key, ts] of Object.entries(map)) {
    if (ts > cutoff) pruned[key] = ts;
  }
  await chrome.storage.local.set({ sent: pruned });
}
