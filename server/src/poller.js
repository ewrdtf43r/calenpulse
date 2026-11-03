import { fetchAccessToken, listUpcoming } from './google.js';
import { buildReminderText, sendDiscord, sendTelegram } from './notify.js';

const SENT_TTL = 3 * 24 * 3600 * 1000;
const AFTER_START_GRACE = 5 * 60 * 1000;

export function startPoller({ store, vault, intervalMs = 30_000, ttlDays = 30, logger = console }) {
  const tokens = new Map();
  let running = false;
  let timer = null;

  async function accessTokenFor(id, cfg) {
    const cached = tokens.get(id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const { accessToken, expiresIn } = await fetchAccessToken(cfg);
    tokens.set(id, { accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    return accessToken;
  }

  async function pollWith(id, record, cfg) {
    let accessToken = await accessTokenFor(id, cfg);
    try {
      await pollCalendar(id, record, cfg, accessToken);
    } catch (e) {
      if (e.code !== 'unauthorized') throw e;
      tokens.delete(id);
      accessToken = await accessTokenFor(id, cfg);
      await pollCalendar(id, record, cfg, accessToken);
    }
  }

  async function pollCalendar(id, record, cfg, accessToken) {
    const now = Date.now();
    const reminders = Array.isArray(cfg.reminders) && cfg.reminders.length ? cfg.reminders : [60, 10];
    const maxLead = Math.max(...reminders, 0);
    const horizon = Math.min(now + (maxLead + 60) * 60_000, now + 7 * 86_400_000);
    const timeMin = new Date(now - 60_000).toISOString();
    const timeMax = new Date(horizon).toISOString();
    const calendars = Array.isArray(cfg.calendars) && cfg.calendars.length
      ? cfg.calendars
      : [{ id: 'primary', summary: 'Основной', primary: true }];

    record.lastError = '';
    if (!record.sent) record.sent = {};

    const targets = [];
    if (cfg.channels?.telegram?.enabled) targets.push('telegram');
    if (cfg.channels?.discord?.enabled) targets.push('discord');
    if (!targets.length) {
      record.lastPollAt = Date.now();
      return;
    }

    const seen = new Set();

    for (const cal of calendars) {
      let events;
      try {
        events = await listUpcoming({ accessToken, calendarId: cal.id, timeMin, timeMax });
      } catch (e) {
        if (e.code === 'unauthorized') throw e;
        record.lastError = `${cal.summary}: ${e.message}`;
        logger.warn(`[poll ${id.slice(0, 8)}] ${record.lastError}`);
        continue;
      }

      for (const event of events) {
        if (event.status === 'cancelled') continue;
        if (!event.start?.dateTime) continue;
        const self = event.attendees?.find((a) => a.self);
        if (self?.responseStatus === 'declined') continue;

        const dedupeKey = `${event.iCalUID || event.id}|${event.start.dateTime}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const start = Date.parse(event.start.dateTime);
        const end = Date.parse(event.end?.dateTime || event.start.dateTime);
        if (Number.isNaN(start) || end < now - 60_000) continue;

        const diff = start - now;
        for (const lead of reminders) {
          if (diff < -AFTER_START_GRACE || diff > lead * 60_000 + 60_000) continue;
          const text = buildReminderText({
            event: { ...event, calendarName: cal.primary ? '' : cal.summary },
            lead,
            timezone: cfg.timezone,
          });
          for (const channel of targets) {
            const key = `${cal.id}|${event.id}|${event.start.dateTime}|${lead}|${channel}`;
            if (record.sent[key]) continue;
            try {
              if (channel === 'telegram') await sendTelegram(cfg.channels.telegram, text);
              else await sendDiscord(cfg.channels.discord, text);
              record.sent[key] = Date.now();
              record.lastSentAt = Date.now();
            } catch (e) {
              record.lastError = `${channel}: ${e.message}`;
              logger.warn(`[poll ${id.slice(0, 8)}] ${record.lastError}`);
            }
          }
        }
      }
    }

    const cutoff = Date.now() - SENT_TTL;
    for (const [key, ts] of Object.entries(record.sent)) {
      if (ts < cutoff) delete record.sent[key];
    }

    record.lastPollAt = Date.now();
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      // Запись обновляется только когда расширение реально синхронизируется (PUT).
      // Если этого не случилось за ttlDays — считаем аккаунт брошенным (ключ утерян,
      // расширение удалено) и перестаём держать валидный refresh token на сервере.
      const staleBefore = ttlDays > 0 ? Date.now() - ttlDays * 86_400_000 : 0;

      for (const [id, record] of store.entries()) {
        if (!record.enc) continue;
        const lastSeen = record.updatedAt || record.createdAt || 0;
        if (staleBefore && lastSeen && lastSeen < staleBefore) {
          store.remove(id);
          tokens.delete(id);
          logger.log(
            `[poll ${id.slice(0, 8)}] не синхронизировался ${Math.round((Date.now() - lastSeen) / 86_400_000)} дн — удалён`
          );
          continue;
        }
        try {
          const cfg = vault.decrypt(record.enc);
          await pollWith(id, record, cfg);
        } catch (e) {
          record.lastPollAt = Date.now();
          record.lastError =
            e.code === 'invalid_grant'
              ? 'Google отклонил refresh token — переподключите аккаунт в расширении'
              : `Google: ${e.message}`;
          logger.warn(`[poll ${id.slice(0, 8)}] ${record.lastError}`);
        }
        if (store.get(id) === record) store.put(id, record);
      }
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => {
    tick().catch((e) => logger.error(`[poller] ${e.message}`));
  }, intervalMs);
  timer.unref?.();
  tick().catch((e) => logger.error(`[poller] ${e.message}`));

  return {
    stop() {
      clearInterval(timer);
    },
    forget(id) {
      tokens.delete(id);
    },
    tick,
  };
}
