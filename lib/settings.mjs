import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const FILE = path.join(DATA_DIR, 'settings.json');

function sanitizeReplacements(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(r => r && typeof r.from === 'string' && r.from.trim() && typeof r.to === 'string')
    .slice(0, 500)
    .map(r => ({ from: r.from.slice(0, 100), to: r.to.slice(0, 100) }));
}

// replacements: 文字起こしの後に自動で直す言葉のリスト（よく間違える名前など）
export async function getSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return { replacements: sanitizeReplacements(saved.replacements) };
  } catch {
    return { replacements: [] };
  }
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()) };
  if (patch.replacements !== undefined) next.replacements = sanitizeReplacements(patch.replacements);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(next, null, 2));
  return next;
}
