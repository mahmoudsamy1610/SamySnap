// A strict in-memory fake of the parts of Google Drive v3 we use.
// It ENFORCES the resumable-upload rules so tests fail if the client breaks them:
//   * non-final chunks must be multiples of 256 KiB,
//   * each chunk must start exactly at the first byte not yet received,
//   * the final chunk's end must match the declared total,
//   * every request needs a valid bearer token.
// Usable as an in-process `fetch` (asFetch) or as a real HTTP server (listen).

import http from 'node:http';

export const ALIGN = 256 * 1024;

let counter = 0;
const newId = (p) => `${p}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class FakeDrive {
  constructor({ base = 'https://fake.drive', validTokens = ['tok-1'] } = {}) {
    this.base = base;
    this.validTokens = new Set(validTokens);
    this.files = new Map(); // id → {id, name, mimeType, parents, data: Buffer, permissions: []}
    this.sessions = new Map(); // sid → {fileId, received: Buffer[], size, complete}
    this.log = []; // {method, path, contentRange, bodySize}
    this.faults = []; // queue of fault descriptors applied to matching requests
    this.shareBlocked = false;
    this.failSessionStart = false;
    this.inflight = 0;
    this.maxInflight = 0;
    this.partialPersist = null; // (chunkSize) => bytesToKeep, simulates Drive keeping fewer bytes
  }

  /**
   * Queue a fault for the next request whose path matches `match`.
   * kind: 'network' (connection dropped before processing),
   *       'network-after' (bytes are stored, then connection drops),
   *       a number (HTTP status returned without processing),
   *       'status-after:<n>' (bytes stored, then HTTP n returned)
   */
  fault(kind, { match = '/upload/session/', times = 1 } = {}) {
    for (let i = 0; i < times; i++) this.faults.push({ kind, match });
  }

  fileData(fileId) {
    return this.files.get(fileId)?.data ?? null;
  }

  // ---------------------------------------------------------------------------

  /** Core handler. Returns {status, headers, body} or {network: true}. */
  async handle(method, urlStr, headers, body) {
    const url = new URL(urlStr, this.base);
    const path = url.pathname;
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.log.push({ method, path, contentRange: h['content-range'], bodySize: body?.length ?? 0, at: Date.now() });

    const faultIdx = this.faults.findIndex((f) => path.includes(f.match));
    const fault = faultIdx >= 0 ? this.faults.splice(faultIdx, 1)[0] : null;
    if (fault?.kind === 'network') return { network: true };
    if (typeof fault?.kind === 'number') return json(fault.kind, { error: { code: fault.kind, message: 'injected' } });

    const auth = h.authorization || '';
    const token = auth.replace(/^Bearer /, '');
    if (!this.validTokens.has(token)) {
      return json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    }

    let res;
    if (method === 'GET' && path === '/drive/v3/files') res = this.#list(url);
    else if (method === 'POST' && path === '/drive/v3/files') res = this.#create(body);
    else if (method === 'POST' && /^\/drive\/v3\/files\/[^/]+\/permissions$/.test(path)) res = this.#share(path.split('/')[4], body);
    else if (method === 'DELETE' && path.startsWith('/drive/v3/files/')) res = this.#delete(path.split('/')[4]);
    else if (method === 'PATCH' && path.startsWith('/upload/drive/v3/files/')) res = this.#startSession(path.split('/')[5], url, h);
    else if (method === 'PUT' && path.startsWith('/upload/session/')) res = this.#chunk(path.split('/')[3], h, body);
    else res = json(404, { error: { code: 404, message: `no route ${method} ${path}` } });

    if (fault?.kind === 'network-after') return { network: true };
    if (typeof fault?.kind === 'string' && fault.kind.startsWith('status-after:')) {
      const st = Number(fault.kind.split(':')[1]);
      return json(st, { error: { code: st, message: 'injected after processing' } });
    }
    return res;
  }

  #list(url) {
    const q = url.searchParams.get('q') || '';
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
    const mime = /mimeType = '([^']*)'/.exec(q)?.[1];
    const files = [...this.files.values()]
      .filter((f) => !f.trashed && (!name || f.name === name) && (!mime || f.mimeType === mime))
      .map((f) => ({ id: f.id }));
    return json(200, { files });
  }

  #create(body) {
    const meta = JSON.parse(body.toString() || '{}');
    for (const p of meta.parents || []) {
      if (!this.files.has(p)) return json(404, { error: { code: 404, message: `File not found: ${p}`, errors: [{ reason: 'notFound' }] } });
    }
    const id = newId('f');
    this.files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || [], data: Buffer.alloc(0), permissions: [] });
    return json(200, { id });
  }

  #share(fileId, body) {
    const f = this.files.get(fileId);
    if (!f) return json(404, { error: { code: 404, message: 'not found' } });
    if (this.shareBlocked) {
      return json(403, {
        error: { code: 403, message: 'The user does not have sufficient permissions', errors: [{ reason: 'publishOutNotPermitted' }] },
      });
    }
    const perm = JSON.parse(body.toString());
    f.permissions.push(perm);
    return json(200, { id: newId('p') });
  }

  #delete(fileId) {
    if (!this.files.delete(fileId)) return json(404, { error: { code: 404, message: 'not found' } });
    return { status: 204, headers: {}, body: '' };
  }

  #startSession(fileId, url, h) {
    if (url.searchParams.get('uploadType') !== 'resumable') return json(400, { error: { message: 'uploadType' } });
    if (!this.files.has(fileId)) return json(404, { error: { code: 404, message: 'not found' } });
    if (this.failSessionStart) return json(500, { error: { code: 500, message: 'backend error' } });
    const sid = newId('s');
    this.sessions.set(sid, { fileId, chunks: [], size: 0, complete: false, contentType: h['x-upload-content-type'] });
    return { status: 200, headers: { Location: `${this.base}/upload/session/${sid}` }, body: '' };
  }

  #chunk(sid, h, body) {
    const s = this.sessions.get(sid);
    if (!s) return json(404, { error: { code: 404, message: 'session not found' } });
    const cr = h['content-range'];
    const done = () => {
      const f = this.files.get(s.fileId);
      f.data = Buffer.concat(s.chunks);
      return json(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.data.length) });
    };
    const incomplete = () => ({
      status: 308,
      headers: s.size > 0 ? { Range: `bytes=0-${s.size - 1}` } : {},
      body: '',
    });

    if (s.complete) return done();

    // Status query: "bytes */*" or "bytes */TOTAL"
    let m = /^bytes \*\/(\*|\d+)$/.exec(cr || '');
    if (m) {
      if (m[1] !== '*' && Number(m[1]) === s.size) {
        s.complete = true;
        return done();
      }
      return incomplete();
    }

    m = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(cr || '');
    if (!m) return json(400, { error: { message: `bad Content-Range: ${cr}` } });
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = m[3] === '*' ? null : Number(m[3]);
    const len = end - start + 1;
    if (body.length !== len) return json(400, { error: { message: `body ${body.length} != range ${len}` } });
    if (start !== s.size) return json(400, { error: { message: `chunk starts at ${start}, expected ${s.size}` } });
    if (total === null && len % ALIGN !== 0) {
      return json(400, { error: { message: `non-final chunk of ${len} bytes is not a multiple of 256 KiB` } });
    }
    if (total !== null && end + 1 !== total) return json(400, { error: { message: 'final chunk end != total' } });

    let keep = len;
    if (total === null && this.partialPersist) keep = this.partialPersist(len);
    s.chunks.push(body.subarray(0, keep));
    s.size += keep;

    if (total !== null) {
      s.complete = true;
      return done();
    }
    return incomplete();
  }

  // ---------------------------------------------------------------------------
  // Adapters
  // ---------------------------------------------------------------------------

  /** In-process fetch. Tracks concurrency so tests can assert sequential uploads. */
  asFetch({ delayMs = 0 } = {}) {
    return async (url, init = {}) => {
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const headers = headersToObject(init.headers);
        const body = await bodyToBuffer(init.body);
        const res = await this.handle(init.method || 'GET', url, headers, body);
        if (res.network) throw new TypeError('Failed to fetch');
        return new Response(res.status === 204 ? null : res.body, {
          status: res.status,
          headers: res.headers,
        });
      } finally {
        this.inflight--;
      }
    };
  }

  /** Real HTTP server on 127.0.0.1 (with permissive CORS for browser tests). */
  async listen({ staticRoutes = {} } = {}) {
    this.server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Range, X-Upload-Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': 'Location, Range',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const pathOnly = req.url.split('?')[0];
      if (req.method === 'GET' && staticRoutes[pathOnly]) {
        const { type, content } = staticRoutes[pathOnly];
        res.writeHead(200, { 'Content-Type': type, ...cors }).end(content);
        return;
      }
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      try {
        const out = await this.handle(req.method, req.url, req.headers, body);
        if (out.network) {
          req.socket.destroy();
          return;
        }
        res.writeHead(out.status, { ...cors, ...out.headers });
        res.end(out.body);
      } finally {
        this.inflight--;
      }
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address();
    this.base = `http://127.0.0.1:${port}`;
    return this.base;
  }

  close() {
    return new Promise((r) => (this.server ? this.server.close(r) : r()));
  }
}

function json(status, obj) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function headersToObject(h) {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  return { ...h };
}

async function bodyToBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body);
  throw new Error(`unsupported body ${typeof body}`);
}

/** Deterministic pseudo-random bytes. */
export function randomBytes(n, seed = 1) {
  const buf = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x >> 16;
  }
  return buf;
}

/** Simple Map-backed store matching the DriveClient store interface. */
export function memoryStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    async get(k) {
      return m.get(k);
    },
    async set(k, v) {
      m.set(k, v);
    },
    async remove(k) {
      m.delete(k);
    },
  };
}
