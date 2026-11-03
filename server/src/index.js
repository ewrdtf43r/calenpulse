import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStore } from './store.js';
import { createVault } from './crypto.js';
import { startPoller } from './poller.js';
import { TEST_TEXT, sendDiscord, sendTelegram } from './notify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const port = Number(process.env.PORT || 8787);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 30_000);
const accountTtlDays = Number(process.env.ACCOUNT_TTL_DAYS || 30);
const allowHttp = process.env.ALLOW_HTTP === '1';

const store = createStore(path.join(dataDir, 'accounts.json'));
const vault = createVault(dataDir);
const poller = startPoller({ store, vault, intervalMs: pollIntervalMs, ttlDays: accountTtlDays });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  if (allowHttp) return next();
  const secure = req.get('x-forwarded-proto') === 'https' || req.socket.encrypted;
  if (!secure) {
    return res.status(403).json({
      error: 'Только HTTPS. Поставьте Caddy или cloudflared перед сервером, либо ALLOW_HTTP=1 для локальной отладки.',
    });
  }
  next();
});

const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const slot = hits.get(req.ip) || { count: 0, reset: now + 60_000 };
  if (now > slot.reset) {
    slot.count = 0;
    slot.reset = now + 60_000;
  }
  slot.count += 1;
  hits.set(req.ip, slot);
  if (slot.count > 120) return res.status(429).json({ error: 'Слишком много запросов' });
  next();
});
setInterval(() => {
  const now = Date.now();
  for (const [ip, slot] of hits) if (now > slot.reset) hits.delete(ip);
}, 60_000).unref();

if (process.env.LOG_REQUESTS === '1') {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`));
    next();
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireKey(req, res, next) {
  const key = String(req.get('x-sync-key') || '');
  if (key.length < 24) return res.status(401).json({ error: 'Некорректный ключ синхронизации' });
  req.accountId = createHash('sha256').update(key).digest('hex');
  next();
}

const clean = (value, max) => String(value ?? '').trim().slice(0, max);

function normalizeReminders(input, fallback) {
  if (!Array.isArray(input)) return fallback;
  const values = [...new Set(input.map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 10_080)
    .sort((a, b) => b - a);
  if (!values.length) throw new HttpError(400, 'Выберите хотя бы один интервал напоминания');
  return values.slice(0, 8);
}

function isDiscordWebhook(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^(ptb|canary)\./, '');
    return (host === 'discord.com' || host === 'discordapp.com') && url.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

const DEFAULT_CALENDARS = [{ id: 'primary', summary: 'Основной', primary: true }];

function normalizeCalendars(input, fallback) {
  if (!Array.isArray(input) || !input.length) return fallback || DEFAULT_CALENDARS;
  const seen = new Set();
  const calendars = [];
  for (const raw of input.slice(0, 30)) {
    const id = clean(raw?.id, 300);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    calendars.push({
      id,
      summary: clean(raw?.summary, 120) || 'Календарь',
      primary: Boolean(raw?.primary),
    });
  }
  calendars.sort((a, b) => Number(b.primary) - Number(a.primary));
  return calendars.length ? calendars : fallback || DEFAULT_CALENDARS;
}

function buildConfig(body, previous = {}) {
  const refreshToken = clean(body.refreshToken, 500) || previous.refreshToken || '';
  const clientId = clean(body.clientId, 200) || previous.clientId || '';
  const clientSecret = clean(body.clientSecret, 200) || previous.clientSecret || '';
  if (!refreshToken) throw new HttpError(400, 'Не передан refresh token — переподключите Google в расширении');
  if (!clientId) throw new HttpError(400, 'Не передан client id');

  const timezone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(body.timezone || ''))
    ? String(body.timezone)
    : previous.timezone || 'UTC';

  const tgIn = body.channels?.telegram;
  const dcIn = body.channels?.discord;
  const telegram = tgIn && typeof tgIn === 'object'
    ? {
        enabled: Boolean(tgIn.enabled),
        botToken: clean(tgIn.botToken, 200),
        chatId: clean(tgIn.chatId, 64),
      }
    : previous.channels?.telegram || { enabled: false, botToken: '', chatId: '' };
  const discord = dcIn && typeof dcIn === 'object'
    ? {
        enabled: Boolean(dcIn.enabled),
        webhookUrl: clean(dcIn.webhookUrl, 500),
      }
    : previous.channels?.discord || { enabled: false, webhookUrl: '' };

  if (telegram.enabled && (!telegram.botToken || !telegram.chatId)) {
    throw new HttpError(400, 'Для Telegram нужны токен бота и chat id');
  }
  if (discord.enabled && !isDiscordWebhook(discord.webhookUrl)) {
    throw new HttpError(400, 'Discord webhook URL некорректен');
  }

  return {
    refreshToken,
    clientId,
    clientSecret,
    label: clean(body.label, 120) || previous.label || 'Google Календарь',
    email: clean(body.email, 320).toLowerCase() || previous.email || '',
    timezone,
    reminders: normalizeReminders(body.reminders, previous.reminders || [60, 10]),
    calendars: normalizeCalendars(body.calendars, previous.calendars),
    channels: { telegram, discord },
  };
}

function handle(fn) {
  return (req, res) => {
    Promise.resolve().then(() => fn(req, res)).catch((e) => {
      const status = e.status || 500;
      if (status >= 500) console.error(`[api] ${req.method} ${req.path}: ${e.stack || e.message}`);
      res.status(status).json({ error: e.message });
    });
  };
}

function publicStatus(record, cfg) {
  return {
    label: cfg.label,
    email: cfg.email || '',
    timezone: cfg.timezone,
    reminders: cfg.reminders,
    calendars: (cfg.calendars || DEFAULT_CALENDARS).map((cal) => ({
      id: cal.id,
      summary: cal.summary,
    })),
    channels: {
      telegram: {
        enabled: cfg.channels.telegram.enabled,
        configured: Boolean(cfg.channels.telegram.botToken && cfg.channels.telegram.chatId),
      },
      discord: {
        enabled: cfg.channels.discord.enabled,
        configured: Boolean(cfg.channels.discord.webhookUrl),
      },
    },
    lastPollAt: record.lastPollAt || 0,
    lastSentAt: record.lastSentAt || 0,
    lastError: record.lastError || '',
    serverTime: new Date().toISOString(),
  };
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.put(
  '/api/account',
  requireKey,
  handle((req, res) => {
    const id = req.accountId;
    const existing = store.get(id);
    let previous = {};
    if (existing?.enc) {
      try {
        previous = vault.decrypt(existing.enc);
      } catch {
        previous = {};
      }
    }

    const cfg = buildConfig(req.body || {}, previous);
    const record = {
      enc: vault.encrypt(cfg),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      lastPollAt: existing?.lastPollAt || 0,
      lastSentAt: existing?.lastSentAt || 0,
      lastError: '',
      sent: existing?.sent || {},
    };
    store.put(id, record);
    poller.forget(id);

    res.json(publicStatus(record, cfg));
  })
);

app.get(
  '/api/account',
  requireKey,
  handle((req, res) => {
    const record = store.get(req.accountId);
    if (!record?.enc) throw new HttpError(404, 'Аккаунт не найден — выполните синхронизацию из расширения');
    const cfg = vault.decrypt(record.enc);
    res.json(publicStatus(record, cfg));
  })
);

app.post(
  '/api/test',
  requireKey,
  handle(async (req, res) => {
    const record = store.get(req.accountId);
    if (!record?.enc) throw new HttpError(404, 'Аккаунт не найден — выполните синхронизацию из расширения');
    const cfg = vault.decrypt(record.enc);

    const requested = Array.isArray(req.body?.channels) && req.body.channels.length
      ? req.body.channels
      : ['telegram', 'discord'];
    const sent = [];
    const errors = [];

    for (const channel of requested) {
      if (channel === 'telegram') {
        const target = cfg.channels.telegram;
        if (!target.botToken || !target.chatId) {
          errors.push('telegram: не заполнены токен и chat id');
          continue;
        }
        try {
          await sendTelegram(target, TEST_TEXT);
          sent.push('telegram');
        } catch (e) {
          errors.push(`telegram: ${e.message}`);
        }
      } else if (channel === 'discord') {
        const target = cfg.channels.discord;
        if (!target.webhookUrl) {
          errors.push('discord: не заполнен webhook URL');
          continue;
        }
        try {
          await sendDiscord(target, TEST_TEXT);
          sent.push('discord');
        } catch (e) {
          errors.push(`discord: ${e.message}`);
        }
      }
    }

    if (!sent.length) {
      throw new HttpError(400, errors.join('; ') || 'Нет настроенных каналов');
    }
    res.json({ ok: true, sent, errors });
  })
);

app.delete(
  '/api/account',
  requireKey,
  handle((req, res) => {
    store.remove(req.accountId);
    poller.forget(req.accountId);
    res.json({ ok: true });
  })
);

app.use((_req, res) => res.status(404).json({ error: 'Не найдено' }));

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Некорректный JSON' });
  console.error(`[api] ${err.stack || err.message}`);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(
    `CalenPulse server on :${port} (poll every ${pollIntervalMs} ms, https required: ${!allowHttp}, ` +
      `аккаунты без синхронизации ${accountTtlDays > 0 ? `${accountTtlDays} дн удаляются` : 'не удаляются'})`
  );
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  poller.stop();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
