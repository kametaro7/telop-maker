import fs from 'node:fs/promises';
import path from 'node:path';
import { exportVideo, renderFrame } from './exporter.mjs';
import { analyzeAudio, extractAudio, makePreview, makeThumb, probe } from './media.mjs';
import { abortError } from './proc.mjs';
import { getSettings } from './settings.mjs';
import * as store from './store.mjs';
import { applyReplacements, transcribe } from './transcribe.mjs';

// 実行中の処理の進み具合（保存はせず、メモリだけに持つ）
const runtime = new Map();

function slot(id) {
  if (!runtime.has(id)) {
    runtime.set(id, { processing: null, processController: null, processPromise: null, export: { state: 'idle' }, exportController: null, exportPromise: null, deleted: false });
  }
  return runtime.get(id);
}

export function userError(message) {
  return Object.assign(new Error(message), { userMessage: message });
}

function describeError(err) {
  if (err?.userMessage) return { message: err.userMessage };
  return { message: '処理中にエラーが発生しました', detail: String(err?.message || err).slice(0, 2000) };
}

export function publicRuntime(id) {
  const r = runtime.get(id);
  const p = r?.processing;
  const e = r?.export || { state: 'idle' };
  return {
    processing: p ? { stage: p.stage, transcribe: p.transcribe, preview: p.preview, partial: p.partial, retranscribe: !!p.retranscribe } : null,
    export: { state: e.state, progress: e.progress ?? 0, file: e.file ?? null, error: e.error ?? null },
  };
}

// whisper は重いので、同時に動かすのは1本だけにする
let whisperQueue = Promise.resolve();
function withWhisperLock(fn) {
  const next = whisperQueue.then(fn, fn);
  whisperQueue = next.catch(() => {});
  return next;
}

async function runTranscription(id, info, signal, state) {
  const dir = store.projectDir(id);
  const wav = path.join(dir, 'audio.wav');
  try {
    await fs.access(wav);
  } catch {
    state.stage = 'audio';
    const project = await store.get(id);
    await extractAudio(path.join(dir, project.sourceFile), wav, { signal, duration: info.duration });
  }
  const analysis = await analyzeAudio(wav);
  const peaks = Buffer.from(analysis.peaks.buffer, analysis.peaks.byteOffset, analysis.peaks.byteLength);
  await fs.writeFile(path.join(dir, 'peaks.json'), JSON.stringify({ rate: analysis.peakRate, data: peaks.toString('base64') }));

  state.stage = 'waiting';
  return withWhisperLock(async () => {
    if (signal.aborted) throw abortError();
    state.stage = 'transcribe';
    const captions = await transcribe({
      workDir: dir,
      wavPath: wav,
      duration: info.duration,
      maxChars: info.width >= info.height ? 26 : 18,
      signal,
      onProgress: v => {
        state.transcribe = v;
      },
      onPartial: text => {
        state.partial = [...state.partial, text].slice(-3);
      },
    });
    state.transcribe = 1;
    return applyReplacements(captions, (await getSettings()).replacements);
  });
}

// アップロード直後の処理: 動画の情報 → サムネイル → (プレビュー動画づくり と 文字起こし を並行)
export function processProject(id) {
  const r = slot(id);
  const controller = new AbortController();
  const { signal } = controller;
  const state = { stage: 'probe', transcribe: 0, preview: 0, partial: [] };
  r.processing = state;
  r.processController = controller;
  r.processPromise = (async () => {
    const dir = store.projectDir(id);
    try {
      const project = await store.get(id);
      const src = path.join(dir, project.sourceFile);
      const info = await probe(src).catch(() => null);
      if (!info) throw userError('動画として読み込めませんでした。ほかの形式の動画でお試しください');
      if (!(info.duration > 0)) throw userError('動画の長さを読み取れませんでした');
      await store.update(id, p => {
        p.video = info;
      }, { touch: false });
      await makeThumb(src, info, path.join(dir, 'thumb.webp')).catch(() => {});

      const preview = makePreview(src, info, path.join(dir, 'preview.mp4'), {
        signal,
        onProgress: v => {
          state.preview = v;
        },
      });
      preview.catch(() => {});
      const captions = info.audio ? await runTranscription(id, info, signal, state) : [];
      state.stage = 'preview';
      await preview;
      state.preview = 1;

      await store.update(id, p => {
        p.captions = captions;
        p.status = 'ready';
        p.error = null;
        if (!info.audio) p.notice = '音声が入っていない動画なので、文字起こしはしていません。テロップは手で追加できます';
        else p.notice = captions.length ? null : '話し声が見つかりませんでした。テロップは手で追加できます';
      });
    } catch (err) {
      controller.abort();
      if (r.deleted) return;
      await store.update(id, p => {
        p.status = 'error';
        p.error = describeError(err);
      }).catch(() => {});
    } finally {
      if (r.processController === controller) {
        r.processing = null;
        r.processController = null;
      }
    }
  })();
  return r.processPromise;
}

export function retranscribe(id) {
  const r = slot(id);
  if (r.processing) throw userError('いま処理中です。終わるまでお待ちください');
  const controller = new AbortController();
  const state = { stage: 'audio', transcribe: 0, preview: 1, partial: [], retranscribe: true };
  r.processing = state;
  r.processController = controller;
  r.processPromise = (async () => {
    try {
      const project = await store.get(id);
      if (!project?.video?.audio) throw userError('この動画には音声が入っていません');
      await store.update(id, p => {
        p.status = 'processing';
        p.notice = null;
      });
      const captions = await runTranscription(id, project.video, controller.signal, state);
      await store.update(id, p => {
        p.captions = captions;
        p.status = 'ready';
        p.error = null;
        p.notice = captions.length ? null : '話し声が見つかりませんでした';
      });
    } catch (err) {
      if (r.deleted) return;
      await store.update(id, p => {
        p.status = 'ready';
        p.notice = `文字起こしのやり直しに失敗しました: ${describeError(err).message}`;
      }).catch(() => {});
    } finally {
      if (r.processController === controller) {
        r.processing = null;
        r.processController = null;
      }
    }
  })();
  return r.processPromise;
}

export function startExport(id, options) {
  const r = slot(id);
  if (r.export.state === 'running') throw userError('いま書き出し中です');
  const controller = new AbortController();
  const state = { state: 'running', progress: 0 };
  r.export = state;
  r.exportController = controller;
  r.exportPromise = (async () => {
    try {
      const project = await store.get(id);
      const dir = store.projectDir(id);
      const file = await exportVideo({
        project,
        srcPath: path.join(dir, project.sourceFile),
        workDir: dir,
        ...options,
        signal: controller.signal,
        onProgress: v => {
          state.progress = v;
        },
      });
      r.export = { state: 'done', progress: 1, file: path.basename(file) };
      await store.update(id, p => {
        p.lastExport = { file: path.basename(file), at: new Date().toISOString() };
      }, { touch: false }).catch(() => {});
    } catch (err) {
      r.export = err.name === 'AbortError' ? { state: 'idle' } : { state: 'error', error: describeError(err) };
    } finally {
      if (r.exportController === controller) r.exportController = null;
    }
  })();
}

export function cancelExport(id) {
  runtime.get(id)?.exportController?.abort();
}

export async function previewFrame(id, { captions, style, time }) {
  const project = await store.get(id);
  const dir = store.projectDir(id);
  return renderFrame({ project, srcPath: path.join(dir, project.sourceFile), workDir: dir, captions, style, time });
}

// 削除の前に、動いている処理を止めて終わるのを待つ
export async function stopAll(id) {
  const r = runtime.get(id);
  if (!r) return;
  r.deleted = true;
  r.processController?.abort();
  r.exportController?.abort();
  const pending = [r.processPromise, r.exportPromise].filter(Boolean);
  await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, 5000))]);
  runtime.delete(id);
}

export function shutdown() {
  for (const r of runtime.values()) {
    r.processController?.abort();
    r.exportController?.abort();
  }
}

// アプリを閉じたときに途中だった処理を、再開できる状態にしておく
export async function recoverInterrupted() {
  for (const p of await store.list()) {
    if (p.status === 'uploading') {
      await store.remove(p.id);
    } else if (p.status === 'processing') {
      await store.update(p.id, x => {
        if (x.captions?.length && x.video) {
          x.status = 'ready';
          x.notice = '前回、文字起こしのやり直しが途中で止まりました';
        } else {
          x.status = 'error';
          x.error = { message: '前回の処理が途中で止まりました。「もう一度処理する」を押してください' };
        }
      }, { touch: false });
    }
  }
}
