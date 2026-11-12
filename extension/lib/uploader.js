// Streaming upload into a Google Drive resumable session WHILE recording.
//
// Protocol recap (https://developers.google.com/drive/api/guides/manage-uploads#resumable):
//   * Intermediate chunk:  PUT <session>  Content-Range: bytes <start>-<end>/*
//       → 308 Resume Incomplete, header "Range: bytes=0-<last byte received>"
//       → the chunk size MUST be a multiple of 256 KiB.
//   * Final chunk:         PUT <session>  Content-Range: bytes <start>-<end>/<total>
//       → 200/201 with the file metadata.
//   * Status query:        PUT <session>  Content-Range: bytes */*   (empty body)
//       → 308 + Range (what the server has), or 200/201 if already complete.
//
// The server may persist FEWER bytes than we sent, so after every 308 we trust
// the Range header, not what we sent. `pending` always holds exactly the bytes
// from `offset` (first byte the server does not have yet) to the end of what
// MediaRecorder gave us so far.
//
// Requests are strictly sequential: one in flight at a time, run by a single
// loop (#run) that drains the buffer.

import { CHUNK_ALIGN } from './constants.js';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus, sleep as defaultSleep } from './retry.js';

export class UploadError extends Error {
  constructor(message, { status, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'UploadError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Parse "Range: bytes=0-1234" → number of bytes received (1235). Missing → 0. */
export function parseRangeHeader(value) {
  if (!value) return 0;
  const m = /bytes=(\d+)-(\d+)/.exec(value);
  if (!m) throw new UploadError(`Unexpected Range header: ${value}`);
  return Number(m[2]) + 1;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // avoid "unhandled rejection" if nobody awaits yet
  return { promise, resolve, reject };
}

export class ResumableUploader {
  /**
   * @param {object} opts
   * @param {string} opts.sessionUri  resumable session URI (Location header)
   * @param {(url: string, init?: RequestInit) => Promise<Response>} opts.fetch  usually authFetch
   * @param {number} [opts.align]  chunk alignment (256 KiB for Drive)
   * @param {typeof DEFAULT_RETRY} [opts.retry]
   * @param {(ms: number) => Promise<void>} [opts.sleep]  injectable for tests
   * @param {(p: {uploadedBytes: number, totalBytes: number, finishing: boolean}) => void} [opts.onProgress]
   * @param {(err: Error) => void} [opts.onError]  called when retries are exhausted
   */
  constructor({ sessionUri, fetch, align = CHUNK_ALIGN, retry = DEFAULT_RETRY, sleep = defaultSleep, onProgress, onError }) {
    this.sessionUri = sessionUri;
    this.fetch = fetch;
    this.align = align;
    this.retry = retry;
    this.sleep = sleep;
    this.onProgress = onProgress;
    this.onError = onError;

    this.offset = 0; // bytes confirmed by Drive
    this.appended = 0; // bytes received from MediaRecorder
    this.pending = new Blob([]); // bytes [offset, appended)
    this.finishing = false;
    this.completed = false;
    this.result = null; // Drive file metadata after completion
    this.error = null;
    this.running = false;
    this.requestCount = 0;
    this.completion = deferred();
  }

  /** Bytes buffered locally that Drive does not have yet. */
  get bufferedBytes() {
    return this.pending.size;
  }

  /** Add a MediaRecorder chunk. Sends as soon as ≥ 256 KiB is buffered. */
  append(blob) {
    if (this.finishing) throw new UploadError('append() after finish()');
    if (!blob || blob.size === 0) return;
    this.pending = new Blob([this.pending, blob]);
    this.appended += blob.size;
    this.#emitProgress();
    this.#kick();
  }

  /**
   * No more data will come: upload the remainder as the final chunk.
   * @returns {Promise<object>} resolves with Drive's file metadata
   */
  finish() {
    this.finishing = true;
    // If a mid-recording upload had given up, give it a fresh round of retries now.
    if (this.error) return this.resume();
    this.#kick();
    return this.completion.promise;
  }

  /** After a fatal failure (e.g. long network outage): try again from where Drive is. */
  resume() {
    if (this.completed) return Promise.resolve(this.result);
    if (this.error) {
      this.error = null;
      this.completion = deferred();
      this.needsStatusQuery = true; // we don't know what the server got from the last attempt
    }
    this.#kick();
    return this.completion.promise;
  }

  #emitProgress() {
    this.onProgress?.({ uploadedBytes: this.offset, totalBytes: this.appended, finishing: this.finishing });
  }

  #kick() {
    if (this.running || this.completed || this.error) return;
    this.#run();
  }

  async #run() {
    this.running = true;
    try {
      if (this.needsStatusQuery) {
        this.needsStatusQuery = false;
        await this.#withRetry(() => this.#queryStatus());
      }
      while (!this.completed && !this.error) {
        if (!this.finishing && this.#alignedSize() === 0) break; // wait for more data
        await this.#withRetry(() => this.#sendNext());
      }
    } catch (err) {
      this.error = err;
      this.completion.reject(err);
      this.onError?.(err);
    } finally {
      this.running = false;
    }
  }

  #alignedSize() {
    return Math.floor(this.pending.size / this.align) * this.align;
  }

  /**
   * Run one protocol step, retrying transient failures with backoff. Between
   * attempts we ask Drive how many bytes it has (bytes *\/*) and continue from
   * there, so a half-received chunk is never re-sent from the wrong offset.
   */
  async #withRetry(step) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (err) {
        const retryable = !(err instanceof UploadError) || err.retryable;
        if (!retryable || attempt >= this.retry.maxAttempts) throw err;
        await this.sleep(backoffDelay(attempt, this.retry));
        try {
          await this.#queryStatus();
          if (this.completed) return;
        } catch {
          /* status query failed too – the next attempt will retry */
        }
      }
    }
  }

  async #put(headers, body) {
    this.requestCount++;
    let res;
    try {
      // NOTE: 308 without a Location header is returned to us as a normal
      // response by fetch (it is only followed when Location is present).
      res = await this.fetch(this.sessionUri, { method: 'PUT', headers, body });
    } catch (cause) {
      throw new UploadError(`Network error: ${cause?.message || cause}`, { retryable: true, cause });
    }
    return res;
  }

  /** Send the next intermediate (aligned) chunk or the final chunk. */
  async #sendNext() {
    const final = this.finishing;
    let body;
    let range;
    if (final) {
      const total = this.offset + this.pending.size;
      body = this.pending;
      range = this.pending.size > 0 ? `bytes ${this.offset}-${total - 1}/${total}` : `bytes */${total}`;
    } else {
      const size = this.#alignedSize();
      if (size === 0) return;
      body = this.pending.slice(0, size);
      range = `bytes ${this.offset}-${this.offset + size - 1}/*`;
    }
    const res = await this.#put({ 'Content-Range': range }, body);
    await this.#handleResponse(res);
  }

  /** Ask Drive what it has received. */
  async #queryStatus() {
    const res = await this.#put({ 'Content-Range': 'bytes */*' }, null);
    await this.#handleResponse(res);
  }

  async #handleResponse(res) {
    if (res.status === 308) {
      this.#applyReceived(parseRangeHeader(res.headers.get('Range')));
      return;
    }
    if (res.status === 200 || res.status === 201) {
      // Upload complete.
      let meta = null;
      try {
        meta = await res.json();
      } catch {
        /* body is optional for us */
      }
      this.offset = this.appended;
      this.pending = new Blob([]);
      this.completed = true;
      this.result = meta;
      this.#emitProgress();
      this.completion.resolve(meta);
      return;
    }
    const retryable = isRetryableStatus(res.status);
    let detail = '';
    try {
      const text = await res.text();
      try {
        detail = JSON.parse(text)?.error?.message || '';
      } catch {
        detail = text.slice(0, 200);
      }
    } catch {
      /* ignore */
    }
    const hint = res.status === 404 || res.status === 410 ? ' (upload session expired)' : '';
    throw new UploadError(`Upload failed: HTTP ${res.status}${hint}${detail ? ` – ${detail}` : ''}`, {
      status: res.status,
      retryable,
    });
  }

  /** Drive confirmed `received` bytes in total: drop them from the buffer. */
  #applyReceived(received) {
    if (received < this.offset || received > this.offset + this.pending.size) {
      throw new UploadError(
        `Drive reports ${received} bytes received, but local state is ${this.offset}..${this.offset + this.pending.size}`,
      );
    }
    this.pending = this.pending.slice(received - this.offset);
    this.offset = received;
    this.#emitProgress();
  }
}
