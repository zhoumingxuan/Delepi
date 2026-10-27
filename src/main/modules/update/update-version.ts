/**
 * 客户端自动更新：版本号解析与比较（四段 + 预发布）
 *
 * - 版本号来源由调用方保证为 app.getVersion()；
 * - 远端为预发布、本地为正式版时由 manager 按策略判为「无新版本」，本文件只做纯比较。
 */

export interface ParsedUpdateVersion {
  numbers: number[];
  prerelease: string[];
  raw: string;
}

export function parseUpdateVersion(raw: string): ParsedUpdateVersion | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text || text.length > 64) {
    return null;
  }
  const matched = /^[vV]?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!matched) {
    return null;
  }
  const numbers = matched[1].split('.').map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return null;
  }
  while (numbers.length < 4) {
    numbers.push(0);
  }
  const prerelease = matched[2] ? matched[2].split('.').filter((part) => part.length > 0) : [];
  return { numbers, prerelease, raw: text };
}

export function isPrereleaseVersion(raw: string): boolean {
  const parsed = parseUpdateVersion(raw);
  return Boolean(parsed && parsed.prerelease.length > 0);
}

/** 返回 1（left 更新）/ -1（right 更新）/ 0（相等）；任一侧不可解析时返回 0 */
export function compareUpdateVersion(left: string, right: string): number {
  const a = parseUpdateVersion(left);
  const b = parseUpdateVersion(right);
  if (!a || !b) {
    return 0;
  }
  for (let index = 0; index < 4; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
    }
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0;
  }
  if (a.prerelease.length === 0) {
    return 1;
  }
  if (b.prerelease.length === 0) {
    return -1;
  }
  const maxLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) {
        return nx > ny ? 1 : -1;
      }
      continue;
    }
    if (xNumeric) {
      return -1;
    }
    if (yNumeric) {
      return 1;
    }
    if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}
