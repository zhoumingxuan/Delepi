import type Database from 'better-sqlite3';
import type { ExplorationLimits, PublicGoal, PublicResource } from '@shared/types/autonomy';
import { permissionId } from '../permissions/permission-validation';
import { BrokerError, type BrokerSession } from './contracts';
export function brokerScope(db: Database.Database, session: BrokerSession): { goal: PublicGoal; resources: PublicResource[]; limits: ExplorationLimits; destination: { id: string; revision: number; configHash: string } } {
  const binding = db.prepare('SELECT * FROM m2_run_scopes WHERE run_id=?').get(session.context.runId) as Record<string, unknown> | undefined;
  if (!binding || binding.mode !== 'public' || binding.owner_id !== session.context.ownerId || Number(binding.generation) !== session.context.generation) throw new BrokerError('PUBLIC_SCOPE_MISMATCH');
  return JSON.parse(String(binding.snapshot_json));
}
export function brokerResource(db: Database.Database, session: BrokerSession, resourceRef: string): PublicResource {
  const value = db.prepare('SELECT * FROM m2_resources WHERE id=?').get(permissionId(resourceRef)) as Record<string, unknown> | undefined;
  const scope = brokerScope(db, session);
  if (!value || value.goal_id !== scope.goal.id || value.data_scope_id !== scope.goal.dataScopeId) throw new BrokerError('PUBLIC_RESOURCE_NOT_FOUND');
  return { id: String(value.id), goalId: String(value.goal_id), dataScopeId: String(value.data_scope_id), kind: value.kind as PublicResource['kind'],
    ...(value.url ? { url: String(value.url) } : {}), contentHash: String(value.content_hash), sizeBytes: Number(value.size_bytes), revision: Number(value.revision), ...(value.parent_id ? { parentId: String(value.parent_id) } : {}) };
}
export const brokerResourceVersion = (value: PublicResource) => `${value.revision}:${value.contentHash}`;
