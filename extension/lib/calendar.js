import { getAccessToken } from './auth.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

async function request(path, init = {}) {
  let auth = await getAccessToken();
  if (!auth) throw new Error('Google Календарь не подключён');

  const send = (token) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });

  let res = await send(auth.accessToken);
  if (res.status === 401) {
    auth = await getAccessToken({ force: true });
    res = await send(auth.accessToken);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Calendar API: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function normalize(item, calendarId) {
  return {
    id: item.id,
    calendarId,
    iCalUID: item.iCalUID || '',
    summary: item.summary || '(без названия)',
    description: item.description || '',
    location: item.location || '',
    colorId: item.colorId || '',
    allDay: Boolean(item.start?.date),
    start: item.start?.dateTime || item.start?.date,
    end: item.end?.dateTime || item.end?.date,
    htmlLink: item.htmlLink || '',
  };
}

let colorsPromise = null;

export async function getColors() {
  if (!colorsPromise) {
    colorsPromise = (async () => {
      const cached = await chrome.storage.local.get('colorsCache');
      const cache = cached.colorsCache;
      if (cache && Date.now() - cache.at < 7 * 86_400_000) return cache;
      try {
        const data = await request('/colors');
        const fresh = {
          at: Date.now(),
          event: data.event || {},
          calendar: data.calendar || {},
        };
        await chrome.storage.local.set({ colorsCache: fresh });
        return fresh;
      } catch {
        colorsPromise = null;
        return { at: 0, event: {}, calendar: {} };
      }
    })();
  }
  return colorsPromise;
}

export async function listCalendars() {
  const params = new URLSearchParams({
    minAccessRole: 'reader',
    fields: 'items(id,summary,backgroundColor,foregroundColor,selected,primary,accessRole,hidden,deleted)',
  });
  const data = await request(`/users/me/calendarList?${params}`);
  return (data.items || [])
    .filter((cal) => !cal.deleted && !cal.hidden)
    .map((cal) => ({
      id: cal.id,
      summary: cal.summary || 'Календарь',
      color: cal.backgroundColor || '#7c8cff',
      selected: cal.selected !== false,
      primary: Boolean(cal.primary),
      // Роль может прийти в другом регистре или не прийти вовсе — не превращаем
      // отсутствие роли в «только чтение», иначе свои календари становятся недоступными.
      accessRole: String(cal.accessRole || '').toLowerCase(),
    }));
}

export function canWrite(accessRole) {
  const role = String(accessRole || '').toLowerCase();
  return role !== 'reader' && role !== 'freebusyreader';
}

// Видимые календари: всё, кроме «только занятость» — напоминания приходят и из
// календарей только для чтения (праздники, подписки).
export function isVisible(accessRole) {
  return String(accessRole || '').toLowerCase() !== 'freebusyreader';
}

export async function listEvents({ timeMin, timeMax, calendarId = 'primary' }) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    timeMin,
    timeMax,
    fields: 'items(id,iCalUID,summary,description,location,colorId,status,start,end,htmlLink,attendees(self,responseStatus))',
  });
  const data = await request(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return (data.items || [])
    .filter((item) => item.status !== 'cancelled')
    .filter((item) => item.attendees?.find((a) => a.self)?.responseStatus !== 'declined')
    .map((item) => normalize(item, calendarId));
}

function toEventBody({ summary, description, location, startISO, endISO, reminders, allDay }) {
  const body = {
    summary,
    description: description || '',
    location: location || '',
    start: allDay ? { date: startISO } : { dateTime: startISO },
    end: allDay ? { date: endISO } : { dateTime: endISO },
  };
  if (!allDay && Array.isArray(reminders) && reminders.length) {
    body.reminders = {
      useDefault: false,
      overrides: reminders.map((minutes) => ({ method: 'popup', minutes })),
    };
  }
  return body;
}

export async function createEvent({ calendarId = 'primary', ...input }) {
  const data = await request(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(toEventBody(input)),
  });
  return normalize(data, calendarId);
}

export async function updateEvent(id, input, calendarId = 'primary') {
  const data = await request(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(toEventBody(input)),
    }
  );
  return normalize(data, calendarId);
}

export async function deleteEvent(id, calendarId = 'primary') {
  await request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
