import { connectGoogle, disconnectGoogle, authStatus, getAccessToken } from './lib/auth.js';
import * as calendar from './lib/calendar.js';
import { getSettings, saveSettings, getSentMap, saveSentMap } from './lib/store.js';
import { pushConfig, getServerStatus, sendServerTest } from './lib/server.js';

const TICK_ALARM = 'calenpulse-tick';
const SYNC_ALARM = 'calenpulse-sync';

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

async function listAllEvents({ timeMin, timeMax } = {}) {
  const calendars = await calendar.listCalendars();
  const wanted = calendars.filter(
    (cal) => cal.selected && cal.accessRole !== 'freeBusyReader'
  );

  const results = await Promise.all(
    wanted.map(async (cal) => {
      try {
        const events = await calendar.listEvents({
          timeMin,
          timeMax,
          calendarId: cal.id,
        });
        return events.map((event) => ({
          ...event,
          calendarName: cal.summary,
          color: cal.color,
          primary: cal.primary,
          accessRole: cal.accessRole,
        }));
      } catch (e) {
        if (/не подключён|token|credential|401/i.test(e.message)) throw e;
        return [];
      }
    })
  );

  const deduped = new Map();
  for (const event of results.flat()) {
    const key = `${event.iCalUID || event.id}|${event.start}`;
    const previous = deduped.get(key);
    if (!previous || (event.primary && !previous.primary)) deduped.set(key, event);
  }
  return [...deduped.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
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
  const events = await listAllEvents({
    timeMin: new Date(now - 60_000).toISOString(),
    timeMax: new Date(horizon).toISOString(),
  });

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
      const key = `browser|${event.calendarId}|${event.id}|${event.start}|${lead}`;
      if (sent[key]) continue;

      const details = [formatTime(event.start, false), event.location].filter(Boolean);
      await chrome.notifications.create(key, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `${leadLabel(lead)} • ${event.summary}`,
        message: [event.primary ? '' : event.calendarName, ...details].filter(Boolean).join(' · '),
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
    const [prefix, calendarId, eventId] = notificationId.split('|');
    if (prefix !== 'browser') return;
    const events = await listAllEvents({
      timeMin: new Date(Date.now() - 3600_000).toISOString(),
      timeMax: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const event = events.find((e) => e.calendarId === calendarId && e.id === eventId);
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
  'calendars:list': () => calendar.listCalendars(),
  'events:list': (query) => listAllEvents(query),
  'events:create': (input) => calendar.createEvent(input),
  'events:update': ({ id, calendarId, ...input }) => calendar.updateEvent(id, input, calendarId),
  'events:delete': ({ id, calendarId }) => calendar.deleteEvent(id, calendarId),
  'settings:get': getSettings,
  'settings:save': (patch) => saveSettings(patch),
  'server:sync': () => pushConfig(),
  'server:status': () => getServerStatus(),
  'server:test': ({ channels }) => sendServerTest(channels),
  'notify:test': async () => {
    const id = `calenpulse-test-${Date.now()}`;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'CalenPulse',
      message: 'Уведомления в браузере работают.',
      priority: 2,
      requireInteraction: true,
      silent: false,
    });
    const all = await chrome.notifications.getAll();
    return { id, listed: Boolean(all[id]) };
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
