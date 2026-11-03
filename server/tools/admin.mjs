#!/usr/bin/env node
// CLI владельца сервера CalenPulse: посмотреть, чьи аккаунты живут, и удалить нужный.
// Секреты (refresh token, client secret, токен бота, webhook) не печатаются никогда.
//
//   node tools/admin.mjs list
//   node tools/admin.mjs show 3a8f
//   node tools/admin.mjs delete 3a8f --restart
//   node tools/admin.mjs purge --days 30 --restart
//
// DATA_DIR берётся из .env рядом с каталогом server/, как в src/index.js.
// Удаление делает pm2 stop → правка файла → pm2 start: приложение держит записи в памяти
// и на остановке перезаписывает файл собой, поэтому править файл при запущенном процессе нельзя.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createStore } from '../src/store.js';
import { createVault } from '../src/crypto.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PM2_APP = process.env.PM2_APP || 'calenpulse';

let dataDir = path.resolve(serverRoot, 'data');
const envFile = path.join(serverRoot, '.env');
if (existsSync(envFile)) {
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((row) => row.startsWith('DATA_DIR='));
  if (line) dataDir = path.resolve(serverRoot, line.slice('DATA_DIR='.length).trim().replace(/^["']|["']$/g, ''));
}

const accountsFile = path.join(dataDir, 'accounts.json');
const open = () => ({ store: createStore(accountsFile), vault: createVault(dataDir) });

const args = process.argv.slice(2);
const command = args[0];
const target = args[1] && !args[1].startsWith('--') ? args[1] : '';
const manage = args.includes('--restart');
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('ru-RU', { hour12: false }) : '—');

function describe(id, record, vault) {
  let cfg = null;
  try {
    cfg = vault.decrypt(record.enc);
  } catch {
    return { id, broken: true };
  }
  return {
    id,
    email: cfg.email || '—',
    label: cfg.label || '—',
    calendars: (cfg.calendars || []).length,
    reminders: (cfg.reminders || []).join(', '),
    telegram: cfg.channels?.telegram?.enabled ? `вкл (${cfg.channels.telegram.chatId || 'без chat id'})` : 'выкл',
    discord: cfg.channels?.discord?.enabled ? 'вкл' : 'выкл',
    createdAt: fmt(record.createdAt),
    updatedAt: fmt(record.updatedAt),
    lastPollAt: fmt(record.lastPollAt),
    lastSentAt: fmt(record.lastSentAt),
    lastError: (record.lastError || '').slice(0, 70),
  };
}

function pm2(...rest) {
  try {
    execFileSync('pm2', rest, { stdio: 'inherit' });
    return true;
  } catch {
    console.error(`Не удалось выполнить pm2 ${rest.join(' ')} — сделайте это вручную.`);
    return false;
  }
}

function hintRestart() {
  console.log('\nПорядок для ручного режима (иначе приложение вернёт запись из памяти):');
  console.log(`  pm2 stop ${PM2_APP} && node tools/admin.mjs ${command} ${target || '--days 30'} && pm2 start ${PM2_APP}`);
  console.log('Или добавьте флаг --restart — тогда утилита остановит и запустит сама.');
}

const found = (rows) => rows.filter(([id]) => id.startsWith(target));

if (command === 'list' || !command) {
  const { store, vault } = open();
  const rows = [...store.entries()];
  console.log(`Аккаунтов: ${rows.length}  (файл ${accountsFile})\n`);
  for (const [id, record] of rows) {
    const info = describe(id, record, vault);
    if (info.broken) {
      console.log(`${id.slice(0, 12)}  НЕ РАСШИФРОВЫВАЕТСЯ (enc.key не от этого каталога данных?)`);
      continue;
    }
    console.log(
      `${info.id.slice(0, 12)}  ${info.email.padEnd(28)}  ${info.label.padEnd(18)}  ` +
        `календарей ${String(info.calendars).padStart(2)}  TG ${info.telegram.padEnd(18)} DC ${info.discord.padEnd(6)}  ` +
        `синхр ${info.updatedAt}`
    );
    if (info.lastError) console.log(`              ошибка: ${info.lastError}`);
  }
  if (!rows.length) console.log('— пусто —');
  process.exit(0);
}

if (command === 'show') {
  if (!target) { console.error('Нужен префикс хеша: show 3a8f'); process.exit(2); }
  const { store, vault } = open();
  const rows = found([...store.entries()]);
  if (!rows.length) { console.error('Такого аккаунта нет'); process.exit(1); }
  for (const [id, record] of rows) {
    console.log(JSON.stringify({ ...describe(id, record, vault), id }, null, 2));
  }
  process.exit(0);
}

if (command === 'delete' || command === 'purge') {
  if (command === 'delete' && !target) { console.error('Нужен префикс хеша: delete 3a8f'); process.exit(2); }
  let days = 0;
  if (command === 'purge') {
    days = Number(flag('days', '30'));
    if (!Number.isFinite(days) || days <= 0) { console.error('Нужен --days N (N > 0)'); process.exit(2); }
  }

  if (manage) pm2('stop', PM2_APP);
  // Перечитываем файл после остановки: на shutdown приложение перезаписало его своей памятью.
  const { store, vault } = open();
  const rows = [...store.entries()];

  let victims = [];
  if (command === 'delete') {
    const matched = found(rows);
    if (!matched.length) { console.error('Такого аккаунта нет'); if (manage) pm2('start', PM2_APP); process.exit(1); }
    if (matched.length > 1) { console.error(`Префикс неоднозначен: ${matched.length} записей`); if (manage) pm2('start', PM2_APP); process.exit(1); }
    victims = matched;
  } else {
    const before = Date.now() - days * 86_400_000;
    victims = rows.filter(([, record]) => {
      const lastSeen = record.updatedAt || record.createdAt || 0;
      return lastSeen && lastSeen < before;
    });
    console.log(`Старше ${days} дн без синхронизации: ${victims.length} из ${rows.length}`);
  }

  for (const [id, record] of victims) {
    store.remove(id);
    console.log(`удалён ${id.slice(0, 12)}  ${describe(id, record, vault).email}`);
  }
  if (victims.length) store.flush(); else console.log('Нечего удалять.');

  if (manage) {
    if (victims.length) pm2('start', PM2_APP);
    else console.log(`Приложение остановлено — запустите: pm2 start ${PM2_APP}`);
  } else if (victims.length) {
    hintRestart();
  }
  process.exit(0);
}

console.error(`Неизвестная команда: ${command}. Доступно: list, show, delete, purge`);
process.exit(2);
