import { drawSample, fontAvailable } from './renderer.mjs';
import { applyPreset, FONTS, getFont, PRESETS } from './shared/fonts.mjs';
import { api, el, toast } from './util.mjs';

const section = (title, ...children) => el('section', { class: 'panel-section' }, el('h3', {}, title), ...children);
const row = (label, ...controls) => el('div', { class: 'row' }, el('span', { class: 'row-label' }, label), el('div', { class: 'control' }, ...controls.flat()));
const reveal = file => api('POST', '/api/reveal', file ? { file } : {}).catch(err => toast(err.message, { error: true }));

function segmented(options, value, onChange) {
  const buttons = options.map(([v, label]) => el('button', { type: 'button', dataset: { value: v } }, label));
  const box = el('div', { class: 'segmented' }, ...buttons);
  const set = v => buttons.forEach(b => b.classList.toggle('active', b.dataset.value === String(v)));
  buttons.forEach(b => b.addEventListener('click', () => {
    set(b.dataset.value);
    onChange(b.dataset.value);
  }));
  set(value);
  box.setValue = set;
  return box;
}

// デザインタブ
export class DesignPanel {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.built = false;
    this.syncers = [];
  }

  render() {
    if (!this.built) this.build();
    this.sync();
  }

  sync() {
    const style = this.editor.style;
    for (const fn of this.syncers) fn(style);
  }

  update(patch) {
    this.editor.setStyle({ ...this.editor.style, ...patch, preset: 'custom' });
    this.sync();
  }

  range(key, min, max, step = 1, scale = 1) {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const num = el('input', { class: 'num', type: 'number', min: String(min), max: String(max), step: String(step) });
    input.addEventListener('input', () => {
      num.value = input.value;
      this.update({ [key]: Number(input.value) / scale });
    });
    num.addEventListener('change', () => {
      this.update({ [key]: Math.min(max, Math.max(min, Number(num.value) || 0)) / scale });
    });
    this.syncers.push(s => {
      const v = String(Math.round(s[key] * scale * 10) / 10);
      if (document.activeElement !== input) input.value = v;
      if (document.activeElement !== num) num.value = v;
    });
    return [input, num];
  }

  color(key) {
    const input = el('input', { type: 'color' });
    input.addEventListener('input', () => this.update({ [key]: input.value }));
    this.syncers.push(s => {
      input.value = s[key];
    });
    return input;
  }

  check(key, label) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => this.update({ [key]: input.checked }));
    this.syncers.push(s => {
      input.checked = !!s[key];
    });
    return el('label', { class: 'check' }, input, label);
  }

  build() {
    this.built = true;
    const available = new Map(FONTS.map(f => [f.id, fontAvailable(f.family)]));

    const presets = PRESETS.map(p => {
      const canvas = el('canvas', { width: 360, height: 100 });
      const button = el('button', {
        class: 'preset',
        type: 'button',
        title: p.label,
        onclick: () => {
          this.editor.setStyle(applyPreset(this.editor.style, p.id));
          this.sync();
        },
      }, canvas);
      requestAnimationFrame(() => drawSample(canvas, applyPreset(this.editor.style, p.id)));
      this.syncers.push(s => button.classList.toggle('active', s.preset === p.id));
      return el('div', {}, button, el('div', { class: 'preset-label' }, p.label));
    });

    const fontSelect = el('select', { class: 'select' }, ...FONTS.map(f => el('option', { value: f.id }, available.get(f.id) ? f.label : `${f.label}（この画面では表示できません）`)));
    const weightSelect = el('select', { class: 'select' });
    const fontNote = el('p', { class: 'font-missing' }, 'このフォントはブラウザのプレビューでは別の書体になりますが、書き出しには使われます。');
    fontSelect.addEventListener('change', () => {
      const font = getFont(fontSelect.value);
      const current = this.editor.style.weight;
      const face = font.faces.reduce((a, b) => (Math.abs(b.weight - current) < Math.abs(a.weight - current) ? b : a));
      this.update({ fontId: font.id, weight: face.weight });
    });
    weightSelect.addEventListener('change', () => this.update({ weight: Number(weightSelect.value) }));
    let shownFont = null;
    this.syncers.push(s => {
      fontSelect.value = s.fontId;
      const font = getFont(s.fontId);
      if (shownFont !== font.id) {
        shownFont = font.id;
        weightSelect.replaceChildren(...font.faces.map(f => el('option', { value: String(f.weight) }, f.label)));
      }
      weightSelect.value = String(s.weight);
      weightSelect.disabled = font.faces.length < 2;
      fontNote.hidden = available.get(s.fontId);
    });

    const outline = section('フチ', row('太さ', this.range('outlineWidth', 0, 20, 0.5)), row('色', this.color('outlineColor')));
    const boxDetails = el('div', { style: { display: 'grid', gap: '12px' } },
      row('色', this.color('boxColor')), row('濃さ（%）', this.range('boxOpacity', 0, 100, 1, 100)), row('余白', this.range('boxPadding', 0, 40)));
    const position = segmented([['bottom', '下'], ['middle', '中央'], ['top', '上']], this.editor.style.position, v => this.update({ position: v }));
    const marginRow = row('端からの距離', this.range('margin', 0, 400));
    this.syncers.push(s => {
      outline.hidden = s.box;
      boxDetails.hidden = !s.box;
      position.setValue(s.position);
      marginRow.hidden = s.position === 'middle';
    });

    this.container.replaceChildren(
      section('ひな形', el('div', { class: 'preset-grid' }, ...presets)),
      section('文字', row('フォント', fontSelect), fontNote, row('太さ', weightSelect), row('大きさ', this.range('size', 24, 160)), row('色', this.color('color'))),
      outline,
      section('背景の帯', this.check('box', '文字の後ろに帯を敷く'), boxDetails),
      section('影', row('ずらし', this.range('shadow', 0, 12, 0.5)), row('色', this.color('shadowColor')), row('濃さ（%）', this.range('shadowOpacity', 0, 100, 1, 100))),
      section('位置', row('場所', position), marginRow),
      section('その他', this.check('removePunctuation', '「、」「。」を表示しない（スペースにする）')),
    );
  }
}

// 書き出しタブ
export class ExportPanel {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.built = false;
    this.timer = null;
    this.state = { state: 'idle' };
    this.quality = 'standard';
    this.hdrMode = 'keep';
  }

  destroy() {
    clearTimeout(this.timer);
  }

  render() {
    if (!this.built) this.build();
    this.poll();
  }

  build() {
    this.built = true;
    const v = this.editor.project.video;
    const short = Math.min(v.width, v.height);
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    const label = r => (r === 'source' ? `元のサイズ（${v.width}×${v.height}）` : `${even((v.width * Number(r)) / short)}×${even((v.height * Number(r)) / short)}`);
    this.resolution = el('select', { class: 'select' },
      el('option', { value: 'source' }, label('source')),
      ...['2160', '1440', '1080', '720'].filter(r => Number(r) < short).map(r => el('option', { value: r }, label(r))));
    this.exportButton = el('button', { class: 'btn primary block', type: 'button', onclick: () => this.start() }, 'テロップ入りの動画を書き出す');
    this.status = el('div', { class: 'export-status' });
    this.srtStatus = el('div', { class: 'export-status' });

    this.container.replaceChildren(
      section('動画の書き出し',
        row('サイズ', this.resolution),
        row('画質', segmented([['standard', '標準'], ['high', '高画質']], this.quality, value => {
          this.quality = value;
        })),
        v.hdr ? row('HDR', segmented([['keep', 'HDRのまま'], ['sdr', 'SDRに変換']], this.hdrMode, value => {
          this.hdrMode = value;
        })) : null,
        v.hdr ? el('p', { class: 'small-note' }, 'iPhone などで撮った HDR の動画です。投稿先で色が白っぽくなるときは「SDRに変換」を選んでください。') : null,
        this.exportButton,
        this.status),
      section('字幕ファイル',
        el('p', { class: 'small-note' }, 'ほかの編集ソフトや YouTube に読み込める SRT 形式で保存します（文字だけで、デザインは含まれません）。'),
        el('button', { class: 'btn block', type: 'button', onclick: () => this.saveSrt() }, '字幕ファイル（SRT）を保存'),
        this.srtStatus),
      section('保存先',
        el('p', { class: 'small-note' }, 'テロップメーカーのフォルダの中の「書き出し」フォルダに保存されます。'),
        el('button', { class: 'btn ghost small', type: 'button', onclick: () => reveal() }, 'フォルダを開く')),
    );
  }

  async start() {
    const editor = this.editor;
    if (!editor.captions.length && !confirm('テロップが1つもありません。このまま書き出しますか？')) return;
    const tooLong = editor.captions.filter(c => editor.renderer.linesFor(c.text).length > 2).length;
    if (tooLong && !confirm(`3行以上になっているテロップが ${tooLong} 件あります。このまま書き出しますか？`)) return;
    await editor.flushSave();
    this.exportButton.disabled = true;
    try {
      this.state = await api('POST', `/api/projects/${editor.id}/export`, {
        captions: editor.exportPayload(),
        style: editor.style,
        resolution: this.resolution.value,
        quality: this.quality,
        hdrMode: this.hdrMode,
      });
      this.renderStatus();
      this.timer = setTimeout(() => this.poll(), 700);
    } catch (err) {
      toast(err.message, { error: true });
      this.exportButton.disabled = false;
    }
  }

  async poll() {
    clearTimeout(this.timer);
    if (this.editor.closed) return;
    try {
      this.state = await api('GET', `/api/projects/${this.editor.id}/export`);
    } catch {
      return;
    }
    this.renderStatus();
    if (this.state.state === 'running') this.timer = setTimeout(() => this.poll(), 700);
  }

  renderStatus() {
    const s = this.state;
    this.exportButton.disabled = s.state === 'running';
    if (s.state === 'running') {
      const pct = Math.round((s.progress || 0) * 100);
      this.status.replaceChildren(
        el('div', { class: 'progress-row' },
          el('div', { class: 'label' }, el('span', {}, '書き出しています…'), el('span', {}, `${pct}%`)),
          el('div', { class: 'bar' }, el('i', { style: { width: `${pct}%` } }))),
        el('div', {}, el('button', {
          class: 'btn ghost small',
          type: 'button',
          onclick: () => api('POST', `/api/projects/${this.editor.id}/export/cancel`).then(() => this.poll()).catch(() => {}),
        }, '中止')));
    } else if (s.state === 'done' && s.file) {
      this.status.replaceChildren(this.fileBox(s.file, '書き出しが終わりました'));
    } else if (s.state === 'error') {
      this.status.replaceChildren(el('div', { class: 'export-error' },
        s.error?.message || '書き出しに失敗しました',
        s.error?.detail ? el('details', {}, el('summary', {}, 'くわしい内容'), el('pre', { class: 'error-detail' }, s.error.detail)) : null));
    } else {
      this.status.replaceChildren();
    }
  }

  fileBox(file, title) {
    return el('div', { class: 'export-done' },
      el('div', { class: 'hint' }, title),
      el('div', { class: 'file' }, file),
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn small', type: 'button', onclick: () => reveal(file) }, 'Finder で表示'),
        el('a', { class: 'btn ghost small', href: `/api/exports/${encodeURIComponent(file)}`, download: file }, 'ダウンロード')));
  }

  async saveSrt() {
    await this.editor.flushSave();
    try {
      const { file } = await api('POST', `/api/projects/${this.editor.id}/srt`, { captions: this.editor.exportPayload() });
      this.srtStatus.replaceChildren(this.fileBox(file, '保存しました'));
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
}
