import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function createStore(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  let data = { accounts: {} };
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Не удалось прочитать ${file}: ${e.message}`);
    }
  }
  if (!data.accounts) data.accounts = {};

  const persist = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  };

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, 1500);
  };

  return {
    get(id) {
      return data.accounts[id];
    },
    put(id, record) {
      data.accounts[id] = record;
      schedule();
    },
    remove(id) {
      delete data.accounts[id];
      schedule();
    },
    entries() {
      return Object.entries(data.accounts);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
    },
  };
}
