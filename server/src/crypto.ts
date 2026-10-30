import { createHash, randomBytes } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashAgentKey(key: string): string {
  return sha256(key);
}

export function newAgentKey(): string {
  return `agk_${randomBytes(32).toString('hex')}`;
}

export function newInviteCode(): string {
  return randomBytes(18).toString('base64url');
}
