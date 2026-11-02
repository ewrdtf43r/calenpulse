const TIMEOUT = 15_000;

export async function sendTelegram({ botToken, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.description || `Telegram HTTP ${res.status}`);
  }
}

export async function sendDiscord({ webhookUrl }, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
}

export function leadLabel(minutes) {
  if (minutes === 0) return 'Событие начинается';
  if (minutes < 60) return `Через ${minutes} мин`;
  if (minutes % 1440 === 0) return `Через ${minutes / 1440} дн`;
  if (minutes % 60 === 0) return `Через ${minutes / 60} ч`;
  return `Через ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function safeTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function formatWhen(startISO, endISO, timeZone) {
  const tz = safeTimeZone(timeZone || 'UTC');
  const start = new Date(startISO);
  const end = new Date(endISO || startISO);
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: tz }).format(start);
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return `${date}, ${time.format(start)}–${time.format(end)}`;
}

export function buildReminderText({ event, lead, timezone }) {
  const lines = [
    `⏰ ${leadLabel(lead)}`,
    event.summary || '(без названия)',
    `📅 ${formatWhen(event.start?.dateTime, event.end?.dateTime, timezone)}`,
  ];
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.htmlLink) lines.push(event.htmlLink);
  return lines.join('\n');
}

export const TEST_TEXT = '✅ CalPulse: тестовое уведомление. Канал работает.';
