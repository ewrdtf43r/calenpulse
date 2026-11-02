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
    allDay: Boolean(item.start?.date),
    start: item.start?.dateTime || item.start?.date,
    end: item.end?.dateTime || item.end?.date,
    htmlLink: item.htmlLink || '',
  };
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
      accessRole: cal.accessRole || 'reader',
    }));
}

export async function listEvents({ timeMin, timeMax, calendarId = 'primary' }) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    timeMin,
    timeMax,
    fields: 'items(id,iCalUID,summary,description,location,status,start,end,htmlLink,attendees(self,responseStatus))',
  });
  const data = await request(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return (data.items || [])
    .filter((item) => item.status !== 'cancelled')
    .filter((item) => item.attendees?.find((a) => a.self)?.responseStatus !== 'declined')
    .map((item) => normalize(item, calendarId));
}

function toEventBody({ summary, description, location, startISO, endISO, reminders }) {
  const body = {
    summary,
    description: description || '',
    location: location || '',
    start: { dateTime: startISO },
    end: { dateTime: endISO },
  };
  if (Array.isArray(reminders) && reminders.length) {
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
