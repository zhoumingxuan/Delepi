import { lookup as systemLookup } from 'node:dns/promises';
import { isIP, type Socket } from 'node:net';
import * as https from 'node:https';
import * as http from 'node:http';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Transform } from 'node:stream';
import { BrokerError } from './contracts';

export interface ResolvedAddress { address: string; family: number }
export interface PinnedTransportDependencies {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: typeof https.request;
  /** Trusted fixture seam only. Production compares the connected socket with its DNS pin. */
  verifySocket?: (socket: Socket, pin: ResolvedAddress) => boolean;
}
export interface PinnedResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer; receivedBytes: number }
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  // Only ordinary global unicast. Mapped/compatible IPv4, NAT64, 6to4, Teredo, local and special ranges are excluded.
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  if ([...left,...right].some(part => !/^[a-f0-9]{1,4}$/.test(part))) return false;
  const words = halves.length === 1 ? left.map(value => parseInt(value,16)) : [...left, ...Array(8-left.length-right.length).fill('0'), ...right].map(value => parseInt(value,16));
  if (words.length !== 8 || words[0] < 0x2000 || words[0] > 0x3fff) return false;
  return !((words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) || words[0] === 0x2002 || words[0] === 0x3ffe || words[0] === 0x3fff);
}
export function publicHttpsUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrokerError('PUBLIC_URL_BLOCKED'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || host.endsWith('.')
    || !host.includes('.') || isIP(host) || /(^|\.)(localhost|local|internal)$/.test(host)) throw new BrokerError('PUBLIC_URL_BLOCKED');
  return url;
}

/** A single actual HTTP attempt. No redirects, proxies, cookie jar, protocol probes or retries. */
export function createPinnedTransport(dependencies: PinnedTransportDependencies = {}) {
  const resolve = dependencies.resolve ?? (hostname => systemLookup(hostname, { all: true, verbatim: true }));
  const normalizeAddress = (address: string) => isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.toLowerCase() : address;
  const verifySocket = dependencies.verifySocket ?? ((socket, pin) => !!socket.remoteAddress && normalizeAddress(socket.remoteAddress) === normalizeAddress(pin.address));
  return {
    request(options: { url: URL; method: 'GET' | 'POST'; publicAddressOnly: boolean; body?: Buffer; headers?: Record<string,string>;
      signal: AbortSignal; timeoutMs: number; maxWireBytes: number; maxDocumentBytes: number; beforeStart(): void; beforeConnect(): void }): Promise<PinnedResponse> {
      if (!Number.isSafeInteger(options.maxWireBytes) || options.maxWireBytes < 1 || !Number.isSafeInteger(options.maxDocumentBytes) || options.maxDocumentBytes < 1
        || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return Promise.reject(new BrokerError('INVALID_TRANSPORT_LIMIT'));
      const url = options.url, host = url.hostname.replace(/^\[|\]$/g, '');
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return Promise.reject(new BrokerError('DESTINATION_BLOCKED'));
      if (options.publicAddressOnly) publicHttpsUrl(url.href);
      return new Promise((resolvePromise, rejectPromise) => {
        let request: http.ClientRequest | undefined, response: http.IncomingMessage | undefined, decompressor: Transform | undefined;
        let receivedBytes = 0, documentBytes = 0, started = false, closed = false, decoderClosed = true, done = false;
        let result: PinnedResponse | undefined, failure: BrokerError | undefined, resolving = true;
        const chunks: Buffer[] = [];
        const finish = () => {
          if (done || (request && !closed) || !decoderClosed || (!failure && !result)) return;
          done = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort);
          if (failure) rejectPromise(new BrokerError(failure.code, receivedBytes, started)); else resolvePromise(result!);
        };
        const fail = (code: string) => {
          if (done || failure) return;
          failure = new BrokerError(code, receivedBytes, started);
          decompressor?.destroy(); response?.destroy(); request?.destroy();
          finish();
        };
        const abort = () => fail('CANCELLED');
        const timer = setTimeout(() => fail('REQUEST_TIMEOUT'), Math.max(1, Math.min(2147483647, Math.ceil(options.timeoutMs))));
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) { abort(); return; }
        // DNS is already a real network attempt. Its durable started record precedes resolver I/O.
        try { options.beforeStart(); started = true; } catch (error) { fail(error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'OPERATION_START_FAILED'); return; }
        Promise.resolve().then(() => { if (done || failure || options.signal.aborted) throw new BrokerError('CANCELLED'); return resolve(host); }).then(addresses => {
          if (done || failure || options.signal.aborted) return;
          if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 || addresses.some(value => isIP(value.address) !== value.family
            || (options.publicAddressOnly && !isPublicAddress(value.address)))) { fail('DNS_ADDRESS_BLOCKED'); return; }
          resolving = false;
          const pin = addresses[0];
          options.beforeConnect();
          if (options.signal.aborted) { abort(); return; }
          const headers: Record<string,string> = { accept: 'text/plain, text/html, application/json', 'accept-encoding': 'gzip, br, deflate', ...options.headers, host: url.host };
          if (options.body) headers['content-length'] = String(options.body.length);
          const factory = dependencies.request ?? (url.protocol === 'https:' ? https.request : http.request);
          const requestOptions: https.RequestOptions & { autoSelectFamily: boolean } = { protocol: url.protocol, hostname: host, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search,
            method: options.method, headers, agent: false, servername: isIP(host) ? undefined : host, rejectUnauthorized: true,
            // Node may request lookup(all:true) for address-family selection. A
            // string callback in that case creates ERR_INVALID_IP_ADDRESS. Keep
            // this attempt on one checked address and still honor both shapes.
            family: pin.family, autoSelectFamily: false,
            lookup: (_hostname, lookupOptions, callback) => {
              if (lookupOptions.all) callback(null, [pin]);
              else callback(null, pin.address, pin.family);
            } };
          request = factory(requestOptions, incoming => {
            response = incoming;
            if (failure || options.signal.aborted) { incoming.destroy(); return; }
            const encoding = String(incoming.headers['content-encoding'] ?? 'identity').toLowerCase();
            if (encoding === 'gzip') decompressor = createGunzip();
            else if (encoding === 'deflate') decompressor = createInflate();
            else if (encoding === 'br') decompressor = createBrotliDecompress();
            else if (encoding !== 'identity') { fail('CONTENT_ENCODING_BLOCKED'); return; }
            if (decompressor) { decoderClosed = false; decompressor.once('close', () => { decoderClosed = true; finish(); }); }
            incoming.on('data', (chunk: Buffer) => { receivedBytes += chunk.length; if (receivedBytes > options.maxWireBytes) fail('WIRE_BYTES_EXCEEDED'); });
            incoming.once('error', () => fail('RESPONSE_FAILED'));
            incoming.once('aborted', () => fail('RESPONSE_ABORTED'));
            const source = decompressor ? incoming.pipe(decompressor) : incoming;
            source.on('data', (chunk: Buffer) => {
              if (failure) return;
              if (documentBytes + chunk.length > options.maxDocumentBytes) { fail('DOCUMENT_BYTES_EXCEEDED'); return; }
              documentBytes += chunk.length; chunks.push(Buffer.from(chunk));
            });
            source.once('error', () => fail('CONTENT_DECODING_FAILED'));
            source.once('end', () => { if (failure) return; result = { status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks, documentBytes), receivedBytes }; finish(); });
          });
          request.once('error', () => fail('NETWORK_FAILED'));
          request.once('socket', socket => {
            const check = () => { try { if (!verifySocket(socket, pin)) fail('SOCKET_ADDRESS_CHANGED'); } catch { fail('SOCKET_ADDRESS_CHANGED'); } };
            // A fresh or failed Node socket can have connecting=false while
            // pending=true and no peer address. Verify after actual connect;
            // genuine setup errors retain their network-failure receipt.
            if (socket.connecting || socket.pending) socket.prependOnceListener('connect', check); else check();
          });
          request.once('close', () => { closed = true; if (!failure && !result && !response?.complete) failure = new BrokerError('NETWORK_CLOSED', receivedBytes, started); finish(); });
          if (options.body) request.write(options.body);
          request.end();
        }).catch(error => fail(error && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : resolving ? 'DNS_FAILED' : 'NETWORK_FAILED'));
      });
    },
  };
}
export type PinnedTransport = ReturnType<typeof createPinnedTransport>;
