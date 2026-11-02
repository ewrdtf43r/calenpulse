// Client ID публичный: он виден в каждом OAuth-запросе. Client secret задаётся
// в настройках расширения (⚙ → OAuth-клиент) и хранится только в chrome.storage.local.
export const OAUTH_DEFAULTS = {
  clientId: '259012723078-8kujagu05mngomvp2su5shg4unb58sdv.apps.googleusercontent.com',
  clientSecret: '',
  scope:
    'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
};
