import { DesignPanel, ExportPanel } from './panels.mjs';
import { CaptionRenderer } from './renderer.mjs';
import { normalizeStyle } from './shared/fonts.mjs';
import { playResFor } from './shared/layout.mjs';
import { chunkText } from './shared/text.mjs';
import { Timeline } from './timeline.mjs';
import { $, api, clamp, el, formatTime, isTyping, newId, parseTime, toast } from './util.mjs';

const STAGES = {
  probe: '動画を読み込んでいます',
  audio: '音声を取り出しています',
  waiting: 'ほかの動画の文字起こしが終わるのを待っています',
  transcribe: '話している言葉を文字にしています',
  preview: 'プレビュー用の動画を仕上げています',
};
const round3 = n => Math.round(n * 1000) / 1000;

export class Editor {
  constructor(id) {
    this.id = id;
    this.project = null;
    this.captions = [];
    this.style = null;
    this.peaks = null;
    this.selectedId = null;
    this.activeId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.rows = new Map();
    this.dirty = false;
    this.saveChain = Promise.resolve();
    this.events = new AbortController();
    this.video = $('#video');
  }

  get duration() {
    return this.project?.video?.duration || 0;
  }

  get currentTime() {
    return this.video.currentTime || 0;
  }

  listen(target, type, fn, options = {}) {
    target.addEventListener(type, fn, { ...options, signal: this.events.signal });
  }

  async open() {
    const project = await api('GET', `/api/projects/${this.id}`);
    this.project = project;
    $('#projectTitle').value = project.name;
    document.title = `${project.name} - テロップメーカー`;
    this.setSaveState('');
    this.listen($('#projectTitle'), 'change', () => {
      const name = $('#projectTitle').value.trim();
      if (!name) return;
      this.project.name = name;
      document.title = `${name} - テロップメーカー`;
      this.scheduleSave();
    });
    if (this.isBusy(project)) this.startPolling();
    else await this.init(project);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.flushSave({ keepalive: true });
    clearTimeout(this.pollTimer);
    cancelAnimationFrame(this.raf);
    this.events.abort();
    this.timeline?.destroy();
    this.stageObserver?.disconnect();
    this.listObserver?.disconnect();
    this.exportPanel?.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    // 次に開く動画の処理中に、前の動画のテロップや波形が残って見えないように消しておく
    for (const canvas of [$('#overlay'), $('#timeline')]) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    $('#timelineSpacer').style.width = '0px';
    $('#timeLabel').textContent = '0:00.0 / 0:00.0';
    $('#playButton').classList.remove('playing');
    $('#notice').hidden = true;
    $('#tab-design').replaceChildren();
    $('#tab-export').replaceChildren();
    for (const tab of document.querySelectorAll('.tabs [data-tab]')) tab.classList.toggle('active', tab.dataset.tab === 'captions');
    for (const panel of ['captions', 'design', 'export']) $(`#tab-${panel}`).hidden = panel !== 'captions';
    $('#captionList').replaceChildren();
    $('#processing').hidden = true;
  }

  isBusy(project) {
    return project.status === 'processing' || project.status === 'uploading' || !!project.runtime?.processing;
  }

  // ---- 処理中の画面 ----
  startPolling() {
    const poll = async () => {
      if (this.closed) return;
      try {
        const project = await api('GET', `/api/projects/${this.id}`);
        this.project = project;
        if (this.isBusy(project) || project.status === 'error') {
          this.renderProcessing(project);
          if (project.status !== 'error') this.pollTimer = setTimeout(poll, 1000);
          return;
        }
        $('#processing').hidden = true;
        await this.init(project);
      } catch (err) {
        toast(err.message, { error: true });
        this.pollTimer = setTimeout(poll, 3000);
      }
    };
    this.renderProcessing(this.project);
    this.pollTimer = setTimeout(poll, 800);
  }

  renderProcessing(project) {
    const box = $('#processing');
    box.hidden = false;
    $('#captionList').replaceChildren(el('p', { class: 'empty' }, project.status === 'error' ? '' : '文字起こしが終わると、ここにテロップが並びます'));
    if (project.status === 'error') {
      box.replaceChildren(el('div', { class: 'processing-card' },
        el('h2', {}, 'うまく処理できませんでした'),
        el('p', {}, project.error?.message || ''),
        project.error?.detail ? el('details', {}, el('summary', { class: 'hint' }, 'くわしい内容'), el('pre', { class: 'error-detail' }, project.error.detail)) : null,
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'btn ghost danger', type: 'button', onclick: () => this.deleteProject() }, 'この動画を削除'),
          el('button', { class: 'btn primary', type: 'button', onclick: () => this.reprocess() }, 'もう一度処理する')),
      ));
      return;
    }
    const rt = project.runtime?.processing || { stage: 'probe', transcribe: 0, preview: 0, partial: [] };
    const bar = (label, value, note) => el('div', { class: 'progress-row' },
      el('div', { class: 'label' }, el('span', {}, label), el('span', {}, note ?? `${Math.round(value * 100)}%`)),
      el('div', { class: 'bar' }, el('i', { style: { width: `${Math.round(value * 100)}%` } })));
    const hasAudio = project.video ? !!project.video.audio : true;
    box.replaceChildren(el('div', { class: 'processing-card' },
      el('h2', {}, rt.retranscribe ? '文字起こしをやり直しています' : '準備しています'),
      el('p', { class: 'hint' }, STAGES[rt.stage] || STAGES.probe, '（この Mac の中だけで処理しています）'),
      hasAudio ? bar('文字起こし', rt.transcribe, rt.stage === 'transcribe' && rt.transcribe === 0 ? '進行中…' : rt.stage === 'waiting' ? '順番待ち' : undefined) : null,
      rt.retranscribe ? null : bar('プレビュー動画', rt.preview),
      el('div', { class: 'partial' }, ...(rt.partial || []).map(t => el('div', {}, t))),
    ));
  }

  async reprocess() {
    try {
      await api('POST', `/api/projects/${this.id}/reprocess`);
      this.project = await api('GET', `/api/projects/${this.id}`);
      this.startPolling();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async deleteProject() {
    if (!confirm(`「${this.project.name}」を削除しますか？`)) return;
    try {
      await api('DELETE', `/api/projects/${this.id}`);
      location.hash = '';
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // ---- 編集画面の準備 ----
  async init(project) {
    this.project = project;
    this.captions = project.captions.map(c => ({ ...c })).sort((a, b) => a.start - b.start);
    this.style = normalizeStyle(project.style);
    this.playRes = playResFor(project.video.width, project.video.height);
    this.renderer = new CaptionRenderer($('#overlay'));
    this.renderer.setStyle(this.style, this.playRes);

    this.video.src = `/api/projects/${this.id}/media/preview.mp4?v=${encodeURIComponent(project.createdAt)}`;
    this.video.playbackRate = Number($('#rateSelect').value) || 1;
    this.listen(this.video, 'play', () => this.startLoop());
    this.listen(this.video, 'pause', () => this.refresh());
    this.listen(this.video, 'seeked', () => this.refresh());
    this.listen(this.video, 'timeupdate', () => this.video.paused && this.refresh());
    this.listen(this.video, 'loadedmetadata', () => this.refresh());
    this.listen(this.video, 'click', () => this.togglePlay());
    this.listen($('#playButton'), 'click', () => this.togglePlay());
    this.listen($('#rateSelect'), 'change', () => {
      this.video.playbackRate = Number($('#rateSelect').value) || 1;
    });

    this.stageObserver = new ResizeObserver(() => this.layoutStage());
    this.stageObserver.observe($('#stage'));
    // 一覧の幅が変わったら（タブの切り替えやウィンドウの大きさの変更）、入力欄の高さを測り直す
    this.listWidth = 0;
    this.listObserver = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (!width) {
        this.listWidth = 0; // 隠れている間に作り直した行も、次に見えたときに測る
        return;
      }
      if (width === this.listWidth) return;
      this.listWidth = width;
      for (const { text } of this.rows.values()) this.autoGrow(text);
    });
    this.listObserver.observe($('#captionList'));

    this.timeline = new Timeline(this, { scroll: $('#timelineScroll'), spacer: $('#timelineSpacer'), canvas: $('#timeline'), zoom: $('#zoomRange') });
    this.loadPeaks();

    this.design = new DesignPanel(this, $('#tab-design'));
    this.exportPanel = new ExportPanel(this, $('#tab-export'));
    this.bindToolbar();
    this.bindShortcuts();
    this.renderNotice();
    this.renderList();
    this.updateUndoButtons();
    this.layoutStage();
    this.timeline.layout();
    this.refresh();
  }

  async loadPeaks() {
    try {
      const res = await fetch(`/api/projects/${this.id}/media/peaks.json`);
      if (!res.ok) return;
      const { rate, data } = await res.json();
      this.peaks = { rate, data: Uint8Array.from(atob(data), ch => ch.charCodeAt(0)) };
      this.timeline.draw();
    } catch {
      // 波形がなくても編集はできる
    }
  }

  layoutStage() {
    const stage = $('#stage');
    const box = $('#stageBox');
    const { width, height } = this.project.video;
    const availW = Math.max(50, stage.clientWidth - 24);
    const availH = Math.max(50, stage.clientHeight - 24);
    let w = availW;
    let h = (availW * height) / width;
    if (h > availH) {
      h = availH;
      w = (availH * width) / height;
    }
    box.style.width = `${Math.floor(w)}px`;
    box.style.height = `${Math.floor(h)}px`;
    this.renderer.resize(Math.floor(w), Math.floor(h));
    this.drawOverlay();
  }

  bindToolbar() {
    this.listen($('#addCaption'), 'click', () => this.addCaptionAt(this.currentTime));
    this.listen($('#undoButton'), 'click', () => this.undo());
    this.listen($('#redoButton'), 'click', () => this.redo());
    this.listen($('#replaceButton'), 'click', () => this.openReplace());
    this.listen($('#retranscribeButton'), 'click', () => this.retranscribe());
    this.listen($('#frameCheckButton'), 'click', () => this.checkFrame());
    $('#retranscribeButton').disabled = !this.project.video.audio;
    for (const tab of document.querySelectorAll('.tabs [data-tab]')) {
      this.listen(tab, 'click', () => this.showTab(tab.dataset.tab));
    }
    this.showTab('captions');
  }

  showTab(name) {
    for (const tab of document.querySelectorAll('.tabs [data-tab]')) tab.classList.toggle('active', tab.dataset.tab === name);
    for (const panel of ['captions', 'design', 'export']) $(`#tab-${panel}`).hidden = panel !== name;
    if (name === 'design') this.design.render();
    if (name === 'export') this.exportPanel.render();
  }

  bindShortcuts() {
    this.listen(window, 'keydown', e => {
      const typing = isTyping(e.target);
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.flushSave();
      } else if (cmd && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        this.openReplace();
      } else if (cmd && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (!typing && !cmd && e.key === ' ') {
        e.preventDefault();
        this.togglePlay();
      } else if (!typing && !cmd && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        this.seek(this.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
      }
    });
    this.listen(window, 'pagehide', () => this.flushSave({ keepalive: true }));
  }

  renderNotice() {
    const box = $('#notice');
    box.hidden = !this.project.notice;
    if (!this.project.notice) return;
    box.replaceChildren(el('span', {}, this.project.notice), el('button', {
      class: 'mini',
      type: 'button',
      onclick: () => {
        box.hidden = true;
        this.project.notice = null;
        api('PUT', `/api/projects/${this.id}`, { notice: null }).catch(() => {});
      },
    }, '閉じる'));
  }

  // ---- 再生とプレビュー ----
  togglePlay() {
    if (!this.video.src) return;
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  seek(t) {
    this.video.currentTime = clamp(t, 0, Math.max(0, this.duration - 0.01));
    this.refresh();
  }

  startLoop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (this.closed) return;
      this.refresh();
      if (!this.video.paused && !this.video.ended) this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  captionsAt(t) {
    return this.captions.filter(c => c.start <= t && t < c.end);
  }

  refresh() {
    if (!this.renderer || this.closed) return;
    const t = this.currentTime;
    $('#timeLabel').textContent = `${formatTime(t)} / ${formatTime(this.duration)}`;
    $('#playButton').classList.toggle('playing', !this.video.paused);
    const active = this.captionsAt(t)[0]?.id || null;
    if (active !== this.activeId) {
      this.rows.get(this.activeId)?.row.classList.remove('active');
      this.activeId = active;
      const row = this.rows.get(active)?.row;
      row?.classList.add('active');
      if (row && !this.video.paused && !isTyping(document.activeElement)) row.scrollIntoView({ block: 'nearest' });
    }
    this.drawOverlay();
    if (!this.video.paused) this.timeline.follow(t);
    this.timeline.draw();
  }

  drawOverlay() {
    this.renderer?.draw(this.captionsAt(this.currentTime));
  }

  setStyle(style) {
    this.style = normalizeStyle(style);
    this.renderer.setStyle(this.style, this.playRes);
    this.drawOverlay();
    this.updateAllFlags();
    this.scheduleSave();
  }

  // 書き出し用: 画面と同じ行分けをしたテロップ
  exportPayload() {
    return this.captions.map(c => ({ start: c.start, end: c.end, lines: this.renderer.linesFor(c.text) }));
  }

  // ---- テロップ一覧 ----
  renderList() {
    const list = $('#captionList');
    this.rows.clear();
    if (!this.captions.length) {
      list.replaceChildren(el('p', { class: 'empty' }, 'テロップがありません。「＋ 追加」か、タイムラインのダブルクリックで追加できます'));
      return;
    }
    list.replaceChildren(...this.captions.map((c, i) => this.captionRow(c, i)));
    this.rows.get(this.selectedId)?.row.classList.add('selected');
    this.rows.get(this.activeId)?.row.classList.add('active');
  }

  captionRow(c, index) {
    const find = () => this.captions.find(x => x.id === c.id);
    const startInput = this.timeField(c.start, v => this.setTimeFromInput(c.id, 'start', v), '表示の開始');
    const endInput = this.timeField(c.end, v => this.setTimeFromInput(c.id, 'end', v), '表示の終了');
    const text = el('textarea', { rows: 1, spellcheck: false, 'aria-label': `テロップ ${index + 1}` });
    text.value = c.text;
    const flags = el('div', { class: 'cap-flags' });
    const row = el('div', { class: 'cap', dataset: { id: c.id } },
      el('div', { class: 'cap-head' },
        el('span', { class: 'cap-index' }, String(index + 1)),
        startInput, el('span', { class: 'cap-arrow' }, '→'), endInput,
        el('div', { class: 'cap-actions' },
          el('button', { class: 'mini', type: 'button', title: 'ここから再生', onclick: () => this.playFrom(c.id) }, '▶'),
          el('button', { class: 'mini', type: 'button', title: 'カーソルの位置で2つに分ける（⌘Enter）', onclick: () => this.splitCaption(c.id) }, '分割'),
          el('button', { class: 'mini', type: 'button', title: 'ひとつ前のテロップとつなげる', disabled: index === 0, onclick: () => this.mergeWithPrevious(c.id) }, '前と結合'),
          el('button', { class: 'mini danger', type: 'button', title: '削除', onclick: () => this.deleteCaption(c.id) }, '削除'))),
      text,
      flags);

    this.listen(row, 'mousedown', e => {
      if (e.target.closest('button, input, textarea')) return;
      this.select(c.id);
      this.seek(find().start + 0.001);
    });
    this.listen(text, 'focus', () => {
      this.select(c.id);
      this.textSnapshot = this.snapshot();
      const cap = find();
      if (cap && this.video.paused && !(cap.start <= this.currentTime && this.currentTime < cap.end)) this.seek(cap.start + 0.001);
    });
    this.listen(text, 'blur', () => {
      if (this.textSnapshot && this.textSnapshot !== this.snapshot()) this.pushHistory(this.textSnapshot);
      this.textSnapshot = null;
    });
    this.listen(text, 'input', () => {
      const cap = find();
      if (!cap) return;
      cap.text = text.value;
      cap.low = false;
      this.autoGrow(text);
      this.updateFlags(cap.id);
      this.drawOverlay();
      this.timeline.draw();
      this.scheduleSave();
    });
    this.listen(text, 'keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.splitCaption(c.id);
      } else if (e.key === 'Escape') {
        text.blur();
      }
    });

    this.rows.set(c.id, { row, text, startInput, endInput, flags });
    requestAnimationFrame(() => this.autoGrow(text));
    this.updateFlags(c.id);
    return row;
  }

  timeField(value, onCommit, label) {
    const input = el('input', { class: 'time-input', spellcheck: false, 'aria-label': label, title: `${label}（例: 1:02.50）` });
    input.value = formatTime(value, 2);
    this.listen(input, 'keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
    this.listen(input, 'change', () => {
      const v = parseTime(input.value);
      if (v == null) {
        input.classList.add('invalid');
        toast('時間は 1:02.50 のように入力してください', { error: true });
        return;
      }
      input.classList.remove('invalid');
      onCommit(v);
    });
    return input;
  }

  autoGrow(textarea) {
    // 見えていないとき（別のタブを開いている間など）に測ると高さが 0 や1文字幅の折り返しになるので、見えてから測る
    if (!textarea.isConnected || !textarea.clientWidth) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }

  updateFlags(id) {
    const cap = this.captions.find(c => c.id === id);
    const r = this.rows.get(id);
    if (!cap || !r) return;
    const lines = this.renderer.linesFor(cap.text).length;
    // replaceChildren は null を "null" という文字にしてしまうので、先に取り除く
    r.flags.replaceChildren(...[
      cap.low ? el('span', { class: 'badge warn', title: '聞き取りに自信がない部分です。動画を再生して確かめてください' }, '要確認') : null,
      !cap.text.trim() ? el('span', { class: 'badge' }, '空のテロップ') : null,
      lines > 2 ? el('span', { class: 'badge warn', title: '文字を減らすか、分割するか、文字を小さくしてください' }, `${lines}行になっています`) : null,
    ].filter(Boolean));
  }

  updateAllFlags() {
    for (const id of this.rows.keys()) this.updateFlags(id);
  }

  updateRowTimes(id) {
    const cap = this.captions.find(c => c.id === id);
    const r = this.rows.get(id);
    if (!cap || !r) return;
    if (document.activeElement !== r.startInput) r.startInput.value = formatTime(cap.start, 2);
    if (document.activeElement !== r.endInput) r.endInput.value = formatTime(cap.end, 2);
  }

  select(id, { scroll = false } = {}) {
    if (this.selectedId !== id) {
      this.rows.get(this.selectedId)?.row.classList.remove('selected');
      this.selectedId = id;
      this.rows.get(id)?.row.classList.add('selected');
    }
    if (scroll) this.rows.get(id)?.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.timeline?.draw();
  }

  playFrom(id) {
    const cap = this.captions.find(c => c.id === id);
    if (!cap) return;
    this.select(id);
    this.seek(cap.start + 0.001);
    this.video.play().catch(() => {});
  }

  sortCaptions() {
    const before = this.captions.map(c => c.id).join();
    this.captions.sort((a, b) => a.start - b.start);
    return before !== this.captions.map(c => c.id).join();
  }

  setTimeFromInput(id, which, value) {
    const cap = this.captions.find(c => c.id === id);
    if (!cap) return;
    this.pushHistory();
    if (which === 'start') cap.start = round3(clamp(value, 0, cap.end - 0.1));
    else cap.end = round3(clamp(value, cap.start + 0.1, this.duration));
    if (this.sortCaptions()) this.renderList();
    else this.updateRowTimes(id);
    this.refresh();
    this.scheduleSave();
  }

  // タイムラインのドラッグ用
  beginEdit() {
    this.editSnapshot = this.snapshot();
  }

  setCaptionTimes(id, start, end) {
    const cap = this.captions.find(c => c.id === id);
    if (!cap) return;
    cap.start = round3(start);
    cap.end = round3(end);
    this.updateRowTimes(id);
    this.refresh();
  }

  endEdit() {
    if (this.editSnapshot && this.editSnapshot !== this.snapshot()) this.pushHistory(this.editSnapshot);
    this.editSnapshot = null;
    if (this.sortCaptions()) this.renderList();
    this.scheduleSave();
  }

  addCaptionAt(t) {
    let index = this.captions.findIndex(c => c.start > t);
    if (index < 0) index = this.captions.length;
    const prev = this.captions[index - 1];
    const next = this.captions[index];
    const start = Math.max(t, prev ? prev.end : 0);
    const end = Math.min(start + 2, next ? next.start : this.duration);
    if (end - start < 0.3) {
      toast('ここには追加できる時間がありません。前後のテロップを短くしてください', { error: true });
      return;
    }
    this.pushHistory();
    const cap = { id: newId(), start: round3(start), end: round3(end), text: '', low: false };
    this.captions.splice(index, 0, cap);
    this.renderList();
    this.select(cap.id, { scroll: true });
    this.seek(cap.start + 0.001);
    this.rows.get(cap.id)?.text.focus();
    this.scheduleSave();
  }

  splitCaption(id) {
    const index = this.captions.findIndex(c => c.id === id);
    const cap = this.captions[index];
    const r = this.rows.get(id);
    if (!cap || !r) return;
    const text = cap.text;
    let pos = document.activeElement === r.text ? r.text.selectionStart : -1;
    if (!(pos > 0 && pos < text.length)) {
      // カーソルが端にあるときは、真ん中あたりの自然な位置で分ける
      const pieces = chunkText(text, Math.max(2, Math.ceil(Array.from(text).length / 2)));
      pos = pieces.length > 1 ? Array.from(text).slice(0, pieces[0].end).join('').length : -1;
    }
    const left = text.slice(0, pos).trim();
    const right = text.slice(pos).trim();
    if (!left || !right) {
      toast('分けたい位置に文字カーソルを置いてから押してください', { error: true });
      return;
    }
    const t = this.currentTime > cap.start + 0.1 && this.currentTime < cap.end - 0.1 ? this.currentTime : cap.start + ((cap.end - cap.start) * pos) / text.length;
    this.pushHistory();
    const second = { id: newId(), start: round3(t), end: cap.end, text: right, low: cap.low };
    cap.text = left;
    cap.end = round3(t);
    this.captions.splice(index + 1, 0, second);
    this.renderList();
    this.select(second.id);
    this.rows.get(second.id)?.text.focus();
    this.refresh();
    this.scheduleSave();
  }

  mergeWithPrevious(id) {
    const index = this.captions.findIndex(c => c.id === id);
    if (index <= 0) return;
    const prev = this.captions[index - 1];
    const cap = this.captions[index];
    this.pushHistory();
    const needSpace = /[A-Za-z0-9]$/.test(prev.text) && /^[A-Za-z0-9]/.test(cap.text);
    prev.text = `${prev.text}${needSpace ? ' ' : ''}${cap.text}`;
    prev.end = Math.max(prev.end, cap.end);
    prev.low = prev.low || cap.low;
    this.captions.splice(index, 1);
    this.renderList();
    this.select(prev.id, { scroll: true });
    this.refresh();
    this.scheduleSave();
  }

  deleteCaption(id) {
    const index = this.captions.findIndex(c => c.id === id);
    if (index < 0) return;
    this.pushHistory();
    this.captions.splice(index, 1);
    this.renderList();
    const neighbor = this.captions[Math.min(index, this.captions.length - 1)];
    if (neighbor) this.select(neighbor.id);
    this.refresh();
    this.scheduleSave();
    toast('削除しました（「元に戻す」で戻せます）');
  }

  // ---- 元に戻す / やり直す ----
  snapshot() {
    return JSON.stringify(this.captions);
  }

  pushHistory(snapshot = this.snapshot()) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
  }

  restore(snapshot) {
    this.captions = JSON.parse(snapshot);
    this.renderList();
    this.refresh();
    this.updateUndoButtons();
    this.scheduleSave();
  }

  undo() {
    if (document.activeElement?.tagName === 'TEXTAREA') document.activeElement.blur();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  updateUndoButtons() {
    $('#undoButton').disabled = !this.undoStack.length;
    $('#redoButton').disabled = !this.redoStack.length;
  }

  // ---- 置き換え・やり直し・仕上がり確認 ----
  openReplace() {
    if (!this.renderer) return;
    const dialog = $('#replaceDialog');
    const findInput = $('#findInput');
    const replaceInput = $('#replaceInput');
    const count = $('#replaceCount');
    const selected = document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) : '';
    if (selected) findInput.value = selected;
    $('#rememberReplace').checked = false;
    const updateCount = () => {
      const q = findInput.value;
      const n = q ? this.captions.reduce((sum, c) => sum + c.text.split(q).length - 1, 0) : 0;
      count.textContent = q ? `${n}か所見つかりました` : '';
    };
    findInput.oninput = updateCount;
    updateCount();
    dialog.returnValue = '';
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'replace' || !findInput.value) return;
      const from = findInput.value;
      const to = replaceInput.value;
      const n = this.captions.reduce((sum, c) => sum + c.text.split(from).length - 1, 0);
      if (n) {
        this.pushHistory();
        for (const c of this.captions) c.text = c.text.split(from).join(to);
        this.renderList();
        this.refresh();
        this.scheduleSave();
      }
      if ($('#rememberReplace').checked) {
        try {
          const settings = await api('GET', '/api/settings');
          await api('PUT', '/api/settings', { replacements: [...settings.replacements.filter(r => r.from !== from), { from, to }] });
        } catch (err) {
          toast(err.message, { error: true });
          return;
        }
      }
      toast(`${n}か所を置き換えました${$('#rememberReplace').checked ? '（辞書にも登録しました）' : ''}`);
    };
    dialog.showModal();
    findInput.select();
  }

  async retranscribe() {
    if (!confirm('いまのテロップをすべて消して、文字起こしを最初からやり直しますか？\n（辞書に登録した置き換えも反映されます）')) return;
    await this.flushSave();
    try {
      await api('POST', `/api/projects/${this.id}/retranscribe`);
    } catch (err) {
      toast(err.message, { error: true });
      return;
    }
    const id = this.id;
    this.close();
    const next = new Editor(id);
    window.dispatchEvent(new CustomEvent('telop:editor', { detail: next }));
    await next.open();
  }

  async checkFrame() {
    if (!this.renderer) return;
    const dialog = $('#frameDialog');
    const img = $('#frameImage');
    const time = this.currentTime;
    img.removeAttribute('src');
    img.alt = '描いています…';
    $('#frameClose').onclick = () => dialog.close();
    dialog.showModal();
    try {
      const res = await fetch(`/api/projects/${this.id}/frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time, style: this.style, captions: this.exportPayload().filter(c => c.start <= time && time < c.end) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || '描けませんでした');
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(await res.blob());
      img.alt = '書き出しイメージ';
    } catch (err) {
      img.alt = err.message;
    }
  }

  // ---- 保存 ----
  setSaveState(text, error = false) {
    const s = $('#saveState');
    s.textContent = text;
    s.classList.toggle('error', error);
  }

  scheduleSave() {
    this.dirty = true;
    this.setSaveState('編集中…');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 700);
  }

  flushSave({ keepalive = false } = {}) {
    clearTimeout(this.saveTimer);
    if (!this.dirty || !this.project || !this.style) return this.saveChain;
    this.dirty = false;
    const body = JSON.stringify({ name: this.project.name, captions: this.captions, style: this.style });
    if (keepalive) {
      fetch(`/api/projects/${this.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 }).catch(() => {});
      return this.saveChain;
    }
    this.saveChain = this.saveChain.then(async () => {
      this.setSaveState('保存中…');
      try {
        const res = await fetch(`/api/projects/${this.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
        if (!res.ok) throw new Error();
        if (!this.dirty) this.setSaveState('保存しました');
      } catch {
        this.dirty = true;
        this.setSaveState('保存できませんでした', true);
      }
    });
    return this.saveChain;
  }
}
