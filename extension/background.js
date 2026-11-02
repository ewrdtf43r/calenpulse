import { connectGoogle, disconnectGoogle, authStatus, getAccessToken } from './lib/auth.js';
import * as calendar from './lib/calendar.js';
import { getSettings, saveSettings, getSentMap, saveSentMap } from './lib/store.js';
import { pushConfig, getServerStatus, sendServerTest } from './lib/server.js';

const TICK_ALARM = 'calpulse-tick';
const SYNC_ALARM = 'calpulse-sync';

function ensureAlarms() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureAlarms();
});

chrome.runtime.onStartup.addListener(ensureAlarms);

function formatTime(iso, allDay) {
  if (allDay) return 'весь день';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function leadLabel(minutes) {
  if (minutes === 0) return 'Сейчас';
  if (minutes % 60 === 0) return `Через ${minutes / 60} ч`;
  return `Через ${minutes} мин`;
}

async function runTick() {
  const settings = await getSettings();
  await chrome.storage.local.set({ lastScan: { at: Date.now() } });
  if (!settings.localNotifications) return;

  const auth = await getAccessToken().catch(() => null);
  if (!auth) return;

  const now = Date.now();
  const maxLead = Math.max(...settings.reminders, 0);
  const horizon = Math.min(
    now + (maxLead + 60) * 60_000,
    now + 7 * 86_400_000
  );
  const events = await calendar.listEvents(
    new Date(now - 60_000).toISOString(),
    new Date(horizon).toISOString()
  );

  const sent = await getSentMap();
  let changed = false;

  for (const event of events) {
    if (event.allDay) continue;
    const start = new Date(event.start).getTime();
    if (Number.isNaN(start)) continue;
    const diff = start - now;

    for (const lead of settings.reminders) {
      const windowMs = lead * 60_000;
      if (diff > windowMs || diff < -60_000) continue;
      const key = `browser|${event.id}|${event.start}|${lead}`;
      if (sent[key]) continue;

      await chrome.notifications.create(key, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `${leadLabel(lead)} • ${event.summary}`,
        message: [formatTime(event.start, false), event.location].filter(Boolean).join(' · '),
        priority: 2,
      });
      sent[key] = Date.now();
      changed = true;
    }
  }

  if (changed) await saveSentMap(sent);
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  try {
    const [id, eventId] = notificationId.split('|');
    if (id !== 'browser') return;
    const events = await calendar.listEvents(
      new Date(Date.now() - 3600_000).toISOString(),
      new Date(Date.now() + 7 * 86_400_000).toISOString()
    );
    const event = events.find((e) => e.id === eventId);
    if (event?.htmlLink) chrome.tabs.create({ url: event.htmlLink });
  } catch {
    // событие уже неактуально
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) runTick().catch(() => {});
  if (alarm.name === SYNC_ALARM) pushConfig().catch(() => {});
});

const handlers = {
  'auth:connect': async () => {
    const result = await connectGoogle();
    let syncError = '';
    const settings = await getSettings();
    if (settings.serverUrl && settings.syncKey) {
      try {
        await pushConfig();
      } catch (e) {
        syncError = e.message || String(e);
      }
    }
    return { ...result, syncError };
  },
  'auth:disconnect': async () => {
    await disconnectGoogle();
    return { ok: true };
  },
  'auth:status': authStatus,
  'events:list': ({ timeMin, timeMax }) => calendar.listEvents(timeMin, timeMax),
  'events:create': (input) => calendar.createEvent(input),
  'events:update': ({ id, ...input }) => calendar.updateEvent(id, input),
  'events:delete': ({ id }) => calendar.deleteEvent(id),
  'settings:get': getSettings,
  'settings:save': (patch) => saveSettings(patch),
  'server:sync': () => pushConfig(),
  'server:status': () => getServerStatus(),
  'server:test': ({ channels }) => sendServerTest(channels),
  'notify:test': async () => {
    await chrome.notifications.create('test', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'CalPulse',
      message: 'Уведомления в браузере работают.',
    });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message.data || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
