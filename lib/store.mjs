import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const cache = new Map();
const queues = new Map();

export const isValidId = id => typeof id === 'string' && /^p_[a-z0-9]{6,40}$/.test(id);

export function projectDir(id) {
  if (!isValidId(id)) throw new Error('不正なプロジェクトIDです');
  return path.join(PROJECTS_DIR, id);
}

export const projectFile = (id, name) => path.join(projectDir(id), name);

export async function init() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

async function persist(project) {
  const file = projectFile(project.id, 'project.json');
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(project));
  await fs.rename(tmp, file);
}

export async function create(fields) {
  const id = `p_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  await fs.mkdir(projectDir(id), { recursive: true });
  const now = new Date().toISOString();
  const project = { id, createdAt: now, updatedAt: now, ...fields };
  cache.set(id, project);
  await persist(project);
  return project;
}

export async function get(id) {
  if (!isValidId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const project = JSON.parse(await fs.readFile(projectFile(id, 'project.json'), 'utf8'));
    cache.set(id, project);
    return project;
  } catch {
    return null;
  }
}

// 同じプロジェクトへの書き込みは順番に処理する（文字起こしの完了と画面からの保存がぶつからないように）
export function update(id, mutate, { touch = true } = {}) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const project = await get(id);
    if (!project) throw Object.assign(new Error('プロジェクトが見つかりません'), { status: 404 });
    await mutate(project);
    if (touch) project.updatedAt = new Date().toISOString();
    await persist(project);
    return project;
  });
  queues.set(id, next);
  return next;
}

export async function list() {
  let entries = [];
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const project = await get(entry.name);
    if (project) projects.push(project);
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function remove(id) {
  const dir = projectDir(id);
  await (queues.get(id) || Promise.resolve()).catch(() => {});
  cache.delete(id);
  queues.delete(id);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function dirSize(id) {
  let total = 0;
  try {
    for (const name of await fs.readdir(projectDir(id))) {
      const stat = await fs.stat(path.join(projectDir(id), name));
      if (stat.isFile()) total += stat.size;
    }
  } catch {
    // フォルダが無い場合は 0
  }
  return total;
}
