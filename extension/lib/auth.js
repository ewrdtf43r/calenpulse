import { OAUTH_DEFAULTS } from './config.js';
import { getAuth, setAuth, clearAuth, getSettings } from './store.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export async function getOAuthConfig() {
  const settings = await getSettings();
  return {
    clientId: settings.oauth.clientId || OAUTH_DEFAULTS.clientId,
    clientSecret: settings.oauth.clientSecret || OAUTH_DEFAULTS.clientSecret,
    scope: OAUTH_DEFAULTS.scope,
  };
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function tokenRequest(params) {
  const oauth = await getOAuthConfig();
  if (!oauth.clientId) throw new Error('Не задан OAuth Client ID — заполните в настройках расширения');
  const body = new URLSearchParams({ client_id: oauth.clientId, ...params });
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token error ${res.status}`);
  return data;
}

export async function connectGoogle() {
  const oauth = await getOAuthConfig();
  if (!oauth.clientId) {
    throw new Error('Не задан OAuth Client ID — заполните его в настройках расширения');
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: oauth.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: oauth.scope,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();

  let redirected;
  try {
    redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  } catch (e) {
    throw new Error(`Авторизация отменена или заблокирована: ${e.message || e}`);
  }
  const params = new URL(redirected).searchParams;
  const error = params.get('error');
  if (error) throw new Error(`Google вернул ошибку: ${error}`);
  if (params.get('state') !== state) throw new Error('Несовпадение state в OAuth-ответе');
  const code = params.get('code');
  if (!code) throw new Error('Google не вернул код авторизации');

  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const calendar = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).then((r) => (r.ok ? r.json() : null));

  const auth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 - 60_000,
    label: calendar?.summary || 'Google Календарь',
  };
  await setAuth(auth);
  return { label: auth.label, hasRefreshToken: Boolean(auth.refreshToken) };
}

export async function getAccessToken({ force = false } = {}) {
  const auth = await getAuth();
  if (!auth) return null;
  if (!force && auth.accessToken && auth.expiresAt > Date.now()) return auth;
  if (!auth.refreshToken) throw new Error('Нет refresh token — подключите Google заново');

  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  const next = {
    ...auth,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 - 60_000,
  };
  await setAuth(next);
  return next;
}

export async function authStatus() {
  const auth = await getAuth();
  if (!auth) return { connected: false };
  return {
    connected: true,
    label: auth.label || 'Google Календарь',
    hasRefreshToken: Boolean(auth.refreshToken),
  };
}

export async function disconnectGoogle() {
  await clearAuth();
}
