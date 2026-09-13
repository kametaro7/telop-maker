export const $ = (selector, root = document) => root.querySelector(selector);

// 小さな DOM 組み立てヘルパー
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (typeof value !== 'string' && key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `エラーが発生しました (${res.status})`);
  return data;
}

// 進み具合を出したいので XMLHttpRequest でアップロードする
export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else reject(new Error(data?.error || `アップロードに失敗しました (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('アップロードに失敗しました'));
    xhr.send(file);
  });
}

// 0:02.5 のような表示（tenths: 0.1秒単位、digits=2 なら 0.01秒単位）
export function formatTime(sec, digits = 1) {
  const scale = 10 ** digits;
  const total = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * scale));
  const whole = Math.floor(total / scale);
  const frac = String(total % scale).padStart(digits, '0');
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = String(whole % 60).padStart(2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  return digits ? `${body}.${frac}` : body;
}

// "1:02.5" / "62.5" / "1:02:03" を秒にする。読めなければ null
export function parseTime(text) {
  const parts = String(text).trim().replace(/：/g, ':').replace(/．/g, '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}

export const formatDuration = sec => formatTime(sec, 0);

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

let toastTimer;
export function toast(message, { error = false, duration = 3200 } = {}) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, duration);
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const newId = () => `c_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`;
export const isTyping = target => !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
