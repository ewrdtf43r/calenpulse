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

function normalize(item) {
  return {
    id: item.id,
    summary: item.summary || '(без названия)',
    description: item.description || '',
    location: item.location || '',
    allDay: Boolean(item.start?.date),
    start: item.start?.dateTime || item.start?.date,
    end: item.end?.dateTime || item.end?.date,
    htmlLink: item.htmlLink || '',
  };
}

export async function listEvents(timeMin, timeMax) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
    timeMin,
    timeMax,
  });
  const data = await request(`/calendars/primary/events?${params}`);
  return (data.items || [])
    .filter((item) => item.status !== 'cancelled')
    .filter((item) => item.attendees?.find((a) => a.self)?.responseStatus !== 'declined')
    .map(normalize);
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

export async function createEvent(input) {
  const data = await request('/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify(toEventBody(input)),
  });
  return normalize(data);
}

export async function updateEvent(id, input) {
  const data = await request(`/calendars/primary/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(toEventBody(input)),
  });
  return normalize(data);
}

export async function deleteEvent(id) {
  await request(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
