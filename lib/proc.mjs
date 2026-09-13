import { spawn } from 'node:child_process';
import path from 'node:path';

export function abortError() {
  const err = new Error('中止しました');
  err.name = 'AbortError';
  return err;
}

function lineSplitter(onLine) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      onLine?.(line);
    }
  };
}

// 外部コマンドを実行する。stdout/stderr を行単位で受け取れて、AbortSignal で止められる
export function run(cmd, args, { cwd, signal, onStdout, onStderr, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!cmd) return reject(new Error('必要なコマンドが見つかりません'));
    if (signal?.aborted) return reject(abortError());

    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrTail = '';
    const outLines = lineSplitter(onStdout);
    const errLines = lineSplitter(onStderr);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (captureStdout) stdout += chunk;
      outLines(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-6000);
      errLines(chunk);
    });

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', err => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortError());
      if (code === 0) return resolve({ stdout, stderr: stderrTail });
      const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
      const err = new Error(`${path.basename(cmd)} がエラーで終了しました (${code ?? sig})\n${tail}`);
      err.stderr = stderrTail;
      reject(err);
    });
  });
}
