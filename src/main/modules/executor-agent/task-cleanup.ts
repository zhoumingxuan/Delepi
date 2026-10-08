import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

export type TaskCleanupDeferredReason =
  | 'workspace_unavailable'
  | 'invalid_path'
  | 'workspace_root'
  | 'outside_workspace'
  | 'protected_path'
  | 'protection_unresolved'
  | 'path_unresolved'
  | 'symlink'
  | 'unsupported_type'
  | 'identity_changed';

export interface TaskCleanupResult {
  removedPaths: string[];
  deferredPaths: Array<{ path: string; reason: TaskCleanupDeferredReason }>;
  failedPaths: Array<{ path: string; reason: 'delete_failed' }>;
}

export interface TaskCleanupOptions {
  /** Trusted current task finalOutputDir, never a model-supplied cleanup root. */
  workspaceDir?: string;
  temporaryPaths: readonly string[];
  /** Trusted concrete inputs, deliverables and persistent library/runtime paths.
   * Do not pass the userData container: it contains the legitimate task workspace. */
  protectedPaths: readonly string[];
}

interface WorkspaceIdentity {
  originalPath: string;
  canonicalPath: string;
  stat: Stats;
}

interface PathSnapshot {
  absolutePath: string;
  stat: Stats;
  children?: string[];
}

class DeferredCleanup extends Error {
  constructor(readonly reason: TaskCleanupDeferredReason) {
    super(reason);
  }
}

function isAbsolutePath(value: string): boolean {
  return typeof value === 'string' && Boolean(value) && !value.includes('\0') && path.isAbsolute(value);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function hasSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile()
    && !right.isSymbolicLink();
}

async function readWorkspaceIdentity(workspaceDir: string | undefined): Promise<WorkspaceIdentity> {
  if (!workspaceDir || !isAbsolutePath(workspaceDir)) {
    throw new DeferredCleanup('workspace_unavailable');
  }
  const originalPath = path.resolve(workspaceDir);
  const stat = await lstat(originalPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DeferredCleanup('workspace_unavailable');
  }
  const canonicalPath = await realpath(originalPath);
  if (!hasSameIdentity(stat, await lstat(canonicalPath))) {
    throw new DeferredCleanup('workspace_unavailable');
  }
  return { originalPath, canonicalPath, stat };
}

async function revalidateWorkspace(workspace: WorkspaceIdentity): Promise<void> {
  const current = await readWorkspaceIdentity(workspace.originalPath);
  if (current.canonicalPath !== workspace.canonicalPath || !hasSameIdentity(workspace.stat, current.stat)) {
    throw new DeferredCleanup('identity_changed');
  }
}

/** Resolve absent concrete refs through their nearest existing parent. New optional
 * skill directories are still protected; broken links and access errors fail closed. */
async function canonicalizeProtectedPath(absolutePath: string): Promise<string> {
  const suffix: string[] = [];
  let currentPath = absolutePath;
  for (;;) {
    try {
      return path.join(await realpath(currentPath), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await lstat(currentPath);
        // Existing path with failed realpath, e.g. a dangling symlink, is untrusted.
        throw new DeferredCleanup('protection_unresolved');
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(currentPath);
      if (parent === currentPath) throw new DeferredCleanup('protection_unresolved');
      suffix.unshift(path.basename(currentPath));
      currentPath = parent;
    }
  }
}

async function resolveProtectedPaths(protectedPaths: readonly string[]): Promise<string[]> {
  const resolved = new Set<string>();
  for (const protectedPath of protectedPaths) {
    if (!isAbsolutePath(protectedPath)) throw new DeferredCleanup('protection_unresolved');
    const absolutePath = path.resolve(protectedPath);
    resolved.add(absolutePath);
    resolved.add(await canonicalizeProtectedPath(absolutePath));
  }
  return [...resolved].sort();
}

async function readSupportedPath(absolutePath: string): Promise<Stats> {
  const stat = await lstat(absolutePath);
  if (stat.isSymbolicLink()) throw new DeferredCleanup('symlink');
  if (!stat.isFile() && !stat.isDirectory()) throw new DeferredCleanup('unsupported_type');
  return stat;
}

async function snapshotParentChain(workspace: WorkspaceIdentity, target: string): Promise<PathSnapshot[]> {
  const snapshots: PathSnapshot[] = [];
  let currentPath = path.dirname(target);
  while (currentPath !== workspace.canonicalPath) {
    if (!isWithin(workspace.canonicalPath, currentPath)) throw new DeferredCleanup('outside_workspace');
    const stat = await readSupportedPath(currentPath);
    if (!stat.isDirectory()) throw new DeferredCleanup('path_unresolved');
    snapshots.push({ absolutePath: currentPath, stat });
    currentPath = path.dirname(currentPath);
  }
  return snapshots;
}

async function snapshotTree(target: string): Promise<PathSnapshot[]> {
  const snapshots: PathSnapshot[] = [];
  const pending = [target];
  while (pending.length > 0) {
    const absolutePath = pending.pop()!;
    const stat = await readSupportedPath(absolutePath);
    const children = stat.isDirectory() ? (await readdir(absolutePath)).sort() : undefined;
    snapshots.push({ absolutePath, stat, children });
    if (children) {
      for (const name of children) pending.push(path.join(absolutePath, name));
    }
  }
  return snapshots;
}

async function revalidateSnapshots(snapshots: PathSnapshot[], checkContents: boolean): Promise<void> {
  for (const snapshot of snapshots) {
    const stat = await readSupportedPath(snapshot.absolutePath);
    if (!hasSameIdentity(snapshot.stat, stat)) throw new DeferredCleanup('identity_changed');
    if (checkContents && (stat.ctimeMs !== snapshot.stat.ctimeMs
      || stat.mtimeMs !== snapshot.stat.mtimeMs || stat.size !== snapshot.stat.size)) {
      throw new DeferredCleanup('identity_changed');
    }
    if (snapshot.children) {
      const currentChildren = (await readdir(snapshot.absolutePath)).sort();
      if (currentChildren.length !== snapshot.children.length
        || currentChildren.some((name, index) => name !== snapshot.children![index])) {
        throw new DeferredCleanup('identity_changed');
      }
    }
  }
}

function assertUnprotected(targets: string[], protectedPaths: string[]): void {
  if (targets.some((target) => protectedPaths.some((protectedPath) => pathsOverlap(target, protectedPath)))) {
    throw new DeferredCleanup('protected_path');
  }
}

/**
 * Bounded automatic cleanup, not an OS sandbox for arbitrary Shell/Python.
 * Reject links and recheck identities before Node's path-based rm. Concurrent
 * adversarial renames after the last check still require a restricted runner;
 * this helper does not claim a race-free dirfd/unlinkat deletion boundary.
 */
export async function cleanupTaskTemporaryPaths(options: TaskCleanupOptions): Promise<TaskCleanupResult> {
  const result: TaskCleanupResult = { removedPaths: [], deferredPaths: [], failedPaths: [] };
  let workspace: WorkspaceIdentity;
  try {
    workspace = await readWorkspaceIdentity(options.workspaceDir);
  } catch {
    result.deferredPaths = options.temporaryPaths.map((temporaryPath) => ({
      path: temporaryPath, reason: 'workspace_unavailable',
    }));
    return result;
  }

  let protectedPaths: string[];
  try {
    protectedPaths = await resolveProtectedPaths(options.protectedPaths);
  } catch {
    result.deferredPaths = options.temporaryPaths.map((temporaryPath) => ({
      path: temporaryPath, reason: 'protection_unresolved',
    }));
    return result;
  }

  const processedPaths = new Set<string>();
  // Sequential: this helper's own parent/child cleanup requests never race.
  for (const temporaryPath of options.temporaryPaths) {
    try {
      if (!isAbsolutePath(temporaryPath)) throw new DeferredCleanup('invalid_path');
      const absolutePath = path.resolve(temporaryPath);
      if (processedPaths.has(absolutePath)) continue;
      processedPaths.add(absolutePath);
      if (absolutePath === workspace.originalPath || absolutePath === workspace.canonicalPath) {
        throw new DeferredCleanup('workspace_root');
      }
      const lexicalRoot = isWithin(workspace.originalPath, absolutePath)
        ? workspace.originalPath : workspace.canonicalPath;
      if (!isWithin(lexicalRoot, absolutePath)) throw new DeferredCleanup('outside_workspace');
      const target = path.join(workspace.canonicalPath, path.relative(lexicalRoot, absolutePath));
      assertUnprotected([absolutePath, target], protectedPaths);
      await revalidateWorkspace(workspace);
      const parentChain = await snapshotParentChain(workspace, target);
      await readSupportedPath(target);
      if (await realpath(absolutePath) !== target) throw new DeferredCleanup('symlink');
      const tree = await snapshotTree(target);
      await revalidateSnapshots(tree, true);
      const currentProtectedPaths = await resolveProtectedPaths(options.protectedPaths)
        .catch(() => { throw new DeferredCleanup('protection_unresolved'); });
      if (currentProtectedPaths.length !== protectedPaths.length
        || currentProtectedPaths.some((value, index) => value !== protectedPaths[index])) {
        throw new DeferredCleanup('identity_changed');
      }
      assertUnprotected([absolutePath, target], currentProtectedPaths);
      await revalidateSnapshots(parentChain, false);
      await revalidateWorkspace(workspace);
      // Final target check also catches a link/replacement made during revalidation.
      const targetStat = await readSupportedPath(target);
      if (!hasSameIdentity(tree[0].stat, targetStat)) throw new DeferredCleanup('identity_changed');
      try {
        await rm(target, { recursive: targetStat.isDirectory(), force: false });
        result.removedPaths.push(temporaryPath);
      } catch {
        result.failedPaths.push({ path: temporaryPath, reason: 'delete_failed' });
      }
    } catch (error) {
      result.deferredPaths.push({
        path: temporaryPath,
        reason: error instanceof DeferredCleanup ? error.reason : 'path_unresolved',
      });
    }
  }
  return result;
}
