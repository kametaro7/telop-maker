import { Editor } from './editor.mjs';
import { $, api, el, formatBytes, formatDuration, toast, uploadFile } from './util.mjs';

const homeView = $('#homeView');
const editorView = $('#editorView');
const VIDEO_EXT = /\.(mov|mp4|m4v|mts|m2ts|avi|mkv|webm|3gp)$/i;
let editor = null;
let refreshTimer = null;

function route() {
  const m = /^#\/p\/(p_[a-z0-9]+)$/.exec(location.hash);
  if (m) openEditor(m[1]);
  else showHome();
}

async function showHome() {
  editor?.close();
  editor = null;
  editorView.hidden = true;
  homeView.hidden = false;
  $('#titleWrap').hidden = true;
  document.title = 'テロップメーカー';
  await Promise.all([refreshProjects(), checkHealth()]);
}

async function openEditor(id) {
  homeView.hidden = true;
  editorView.hidden = false;
  $('#titleWrap').hidden = false;
  clearTimeout(refreshTimer);
  if (editor?.id === id) return;
  editor?.close();
  editor = new Editor(id);
  try {
    await editor.open();
  } catch (err) {
    toast(err.message, { error: true });
    location.hash = '';
  }
}

async function checkHealth() {
  const box = $('#setupWarning');
  try {
    const h = await api('GET', '/api/health');
    const problems = [];
    if (!h.ffmpeg) problems.push('ffmpeg が見つかりません（ターミナルで <code>brew install ffmpeg-full</code>）');
    else if (!h.ass) problems.push('テロップ入り動画の書き出しには ffmpeg-full が必要です（<code>brew install ffmpeg-full</code>）');
    if (!h.whisper) problems.push('whisper-cli が見つかりません（<code>brew install whisper-cpp</code>）');
    if (!h.model) problems.push('文字起こしのモデルが見つかりません（<code>~/whisper-models/ggml-large-v3-turbo.bin</code>）');
    box.innerHTML = problems.length ? `<strong>準備が足りないものがあります</strong><ul>${problems.map(p => `<li>${p}</li>`).join('')}</ul>` : '';
    box.hidden = !problems.length;
  } catch {
    box.textContent = 'アプリのサーバーに接続できません。起動.command をもう一度開いてください。';
    box.hidden = false;
  }
}

async function refreshProjects() {
  clearTimeout(refreshTimer);
  let projects = [];
  try {
    projects = await api('GET', '/api/projects');
  } catch (err) {
    toast(err.message, { error: true });
  }
  $('#projectGrid').replaceChildren(...projects.map(projectCard));
  $('#projectsEmpty').hidden = projects.length > 0;
  if (projects.some(p => p.status === 'processing' || p.processing)) {
    refreshTimer = setTimeout(() => {
      if (!homeView.hidden) refreshProjects();
    }, 2000);
  }
}

function projectCard(p) {
  const open = () => {
    location.hash = `#/p/${p.id}`;
  };
  const busy = p.status === 'processing' || p.processing;
  const thumb = el('div', { class: 'thumb' });
  thumb.style.backgroundImage = `url("/api/projects/${p.id}/media/thumb.webp")`;
  const sub = [p.duration ? formatDuration(p.duration) : null, p.status === 'ready' ? `テロップ ${p.captionCount}件` : null, p.size ? formatBytes(p.size) : null]
    .filter(Boolean)
    .join('・');
  const card = el(
    'div',
    { class: 'project-card', role: 'link', tabindex: '0', title: p.name, onclick: open, onkeydown: e => e.key === 'Enter' && open() },
    thumb,
    busy ? el('span', { class: 'badge busy' }, '処理中') : p.status === 'error' ? el('span', { class: 'badge error' }, 'エラー') : null,
    el('button', {
      class: 'delete',
      type: 'button',
      title: '削除',
      'aria-label': `${p.name} を削除`,
      onclick: e => {
        e.stopPropagation();
        deleteProject(p);
      },
    }, '×'),
    el('div', { class: 'meta' }, el('div', { class: 'title' }, p.name), el('div', { class: 'sub' }, sub || '　')),
  );
  return card;
}

async function deleteProject(p) {
  if (!confirm(`「${p.name}」を削除しますか？\nアプリに取り込んだ動画と編集内容が消えます（書き出したファイルは残ります）。`)) return;
  try {
    await api('DELETE', `/api/projects/${p.id}`);
    toast('削除しました');
  } catch (err) {
    toast(err.message, { error: true });
  }
  refreshProjects();
}

async function handleFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('video/') || VIDEO_EXT.test(f.name));
  if (!list.length) {
    toast('動画ファイルを選んでください', { error: true });
    return;
  }
  let lastId = null;
  for (const file of list) {
    const bar = el('i');
    const status = el('span', { class: 'hint' }, 'アップロード中 0%');
    const row = el('div', { class: 'upload-row' }, el('span', { class: 'name' }, file.name), el('div', { class: 'bar' }, bar), status);
    $('#uploads').append(row);
    try {
      const { id } = await uploadFile(file, v => {
        bar.style.width = `${(v * 100).toFixed(1)}%`;
        status.textContent = `アップロード中 ${Math.round(v * 100)}%`;
      });
      lastId = id;
      row.remove();
    } catch (err) {
      status.textContent = err.message;
      setTimeout(() => row.remove(), 8000);
    }
  }
  if (lastId && list.length === 1) location.hash = `#/p/${lastId}`;
  else refreshProjects();
}

async function openDictionary() {
  const dialog = $('#dictDialog');
  const rows = $('#dictRows');
  let settings;
  try {
    settings = await api('GET', '/api/settings');
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  const addRow = (rule = { from: '', to: '' }) => {
    rows.append(el('div', { class: 'dict-row' },
      el('input', { value: rule.from, placeholder: 'まちがい（例: てろっぷ）', dataset: { key: 'from' } }),
      el('span', { class: 'hint' }, '→'),
      el('input', { value: rule.to, placeholder: '正しい言葉（例: テロップ）', dataset: { key: 'to' } }),
      el('button', { class: 'mini danger', type: 'button', onclick: e => e.currentTarget.closest('.dict-row').remove() }, '削除'),
    ));
  };
  rows.replaceChildren();
  settings.replacements.forEach(addRow);
  if (!settings.replacements.length) addRow();
  $('#dictAdd').onclick = () => addRow();
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'save') return;
    const replacements = [...rows.querySelectorAll('.dict-row')]
      .map(r => ({ from: r.querySelector('[data-key="from"]').value, to: r.querySelector('[data-key="to"]').value }))
      .filter(r => r.from.trim());
    try {
      await api('PUT', '/api/settings', { replacements });
      toast('辞書を保存しました。次の文字起こしから使われます');
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  dialog.showModal();
}

// ドラッグ＆ドロップとファイル選択
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
$('#pickButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFiles(fileInput.files);
  fileInput.value = '';
});
homeView.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('over');
});
homeView.addEventListener('dragleave', e => {
  if (!homeView.contains(e.relatedTarget)) dropzone.classList.remove('over');
});
homeView.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});
// 編集画面にうっかり落としたときにブラウザが動画を開いてしまわないように
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

$('#homeButton').addEventListener('click', () => {
  location.hash = '';
});
$('#dictButton').addEventListener('click', openDictionary);
$('#openExportsTop').addEventListener('click', () => api('POST', '/api/reveal', {}).catch(err => toast(err.message, { error: true })));

// 文字起こしのやり直しで編集画面が作り直されたとき
window.addEventListener('telop:editor', e => {
  editor = e.detail;
});

window.addEventListener('hashchange', route);
route();
