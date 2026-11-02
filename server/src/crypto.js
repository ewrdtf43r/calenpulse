import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function createVault(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDir, 'enc.key');

  let key;
  if (existsSync(keyPath)) {
    key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
  } else {
    key = randomBytes(32);
    writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('data/enc.key повреждён: нужен 32-байтный ключ в base64');

  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(blob) {
      const buffer = Buffer.from(blob, 'base64');
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const encrypted = buffer.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    },
  };
}
