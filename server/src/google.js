const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

export async function fetchAccessToken({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error_description || data.error || `Google token ${res.status}`);
    error.code = data.error || 'token_error';
    throw error;
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in || 3600 };
}

export async function listUpcoming({ accessToken, timeMin, timeMax }) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    timeMin,
    timeMax,
    fields: 'items(id,summary,status,start,end,location,htmlLink,transparency,attendees(self,responseStatus))',
  });
  const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) {
    const error = new Error('Access token истёк');
    error.code = 'unauthorized';
    throw error;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Calendar API ${res.status}`);
  }
  const data = await res.json();
  return data.items || [];
}
