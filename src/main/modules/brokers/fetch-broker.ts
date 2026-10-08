import type Database from 'better-sqlite3';
import type { PublicResource } from '@shared/types/autonomy';
import { zeroAmounts } from '../budget/ledger';
import { BrokerError, type BrokerSession, type PublicFetchResult } from './contracts';
import { brokerResource, brokerResourceVersion, brokerScope } from './scope';
import { createPinnedTransport, publicHttpsUrl, type PinnedTransport } from './pinned-http';

export function createFetchBroker(db: Database.Database, options: { transport?: PinnedTransport;
  registerSnapshot(session: BrokerSession, parentRef: string, bytes: Buffer, mime: string, url: string, leaseId: string): Promise<PublicResource> }) {
  const transport = options.transport ?? createPinnedTransport();
  return {
    async fetch(session: BrokerSession, resourceRef: string): Promise<PublicFetchResult> {
        const scope = brokerScope(db, session);
        let target = resourceRef;
        const visited = new Set<string>();
        for (let redirects = 0; redirects <= 3; redirects++) {
          const resource = brokerResource(db, session, target);
          if (resource.kind !== 'public_url' || !resource.url) throw new BrokerError('PUBLIC_URL_BLOCKED');
          const url = publicHttpsUrl(resource.url);
          if (visited.has(url.href)) throw new BrokerError('REDIRECT_LOOP');
          visited.add(url.href);
          const units = { ...zeroAmounts(), fetchRequests: 1, downloadBytes: scope.limits.maxDocumentBytes, storageBytes: scope.limits.maxDocumentBytes };
          const lease = await session.prepare({ capability: 'fetch.public', resourceRef: resource.id, resourceVersion: brokerResourceVersion(resource), summary: '读取已登记公开来源并保存公开副本', units });
          let started = false, bytes = 0, storageBytes = 0, settled = false;
          try {
            const response = await session.withSlot(() => transport.request({ url, method: 'GET', publicAddressOnly: true, signal: AbortSignal.any([session.signal, lease.signal]),
              timeoutMs: Math.min(60000, session.clock.remainingMilliseconds()), maxWireBytes: units.downloadBytes, maxDocumentBytes: scope.limits.maxDocumentBytes,
              beforeStart() { session.markStarted(lease.leaseId); started = true; }, beforeConnect() { session.assertLease(lease.leaseId); } }), lease.signal);
            bytes = response.receivedBytes;
            if ([301,302,303,307,308].includes(response.status)) {
              if (!response.headers.location || redirects === 3) throw new BrokerError('REDIRECT_BLOCKED');
              const next = publicHttpsUrl(new URL(response.headers.location, url).href);
              const registered = scope.resources.find(value => value.kind === 'public_url' && value.url === next.href);
              if (!registered) throw new BrokerError('REDIRECT_SCOPE_BLOCKED');
              settled = true; session.settle(lease.leaseId, 'completed', { known: { ...zeroAmounts(), fetchRequests: 1, downloadBytes: bytes } });
              target = registered.id; continue;
            }
            if (response.status < 200 || response.status >= 300) throw new BrokerError('HTTP_STATUS_FAILED');
            const mime = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (!['text/plain','text/html','application/json'].includes(mime)) throw new BrokerError('CONTENT_TYPE_BLOCKED');
            session.assertLease(lease.leaseId);
            const snapshot = await session.withSlot(() => options.registerSnapshot(session, resource.id, response.body, mime, url.href, lease.leaseId), lease.signal);
            storageBytes = response.body.length;
            settled = true; session.settle(lease.leaseId, 'completed', { known: { ...zeroAmounts(), fetchRequests: 1, downloadBytes: bytes, storageBytes } });
            return { resource: snapshot, finalUrl: url.href, receivedBytes: bytes, contentType: mime };
          } catch (error) {
            if (!settled) {
              const transportError = error instanceof BrokerError ? error : undefined;
              bytes = Math.max(bytes, transportError?.receivedBytes ?? 0);
              started ||= transportError?.started ?? false;
              const write = error as { storageBytesWritten?: number; wroteFile?: boolean };
              const unknownStorage = write?.wroteFile ? Math.min(units.storageBytes, write.storageBytesWritten ?? units.storageBytes) : 0;
              session.settle(lease.leaseId, write?.wroteFile ? 'unknown' : started ? session.signal.aborted || lease.signal.aborted ? 'cancelled' : 'failed' : 'not_started', {
                known: { ...zeroAmounts(), fetchRequests: started ? 1 : 0, downloadBytes: bytes, storageBytes }, ...(unknownStorage ? { unknown: { storageBytes: unknownStorage } } : {}),
              });
            }
            throw error;
          }
        }
        throw new BrokerError('REDIRECT_BLOCKED');
    },
  };
}
