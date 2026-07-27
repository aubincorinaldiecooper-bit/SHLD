import type { Redis } from "ioredis";

/**
 * Best-effort per-organization concurrency fairness so one noisy tenant's
 * engine jobs cannot starve others out of the shared worker pool. This is a
 * fairness mechanism, not a security boundary (small acquire/release races
 * are tolerated) — the actual budget/concurrency *entitlement* enforcement
 * lives in the run-creation service, which checks AgentIdentity.permissions
 * against real non-terminal SecurityRun rows.
 */
export class TenantConcurrencyLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limit: number,
    private readonly keyPrefix = "shld:tenant-concurrency",
  ) {}

  private key(organizationId: string): string {
    return `${this.keyPrefix}:${organizationId}`;
  }

  async tryAcquire(organizationId: string, jobId: string): Promise<boolean> {
    const key = this.key(organizationId);
    const count = await this.redis.scard(key);
    if (count >= this.limit) return false;
    await this.redis.sadd(key, jobId);
    return true;
  }

  async release(organizationId: string, jobId: string): Promise<void> {
    await this.redis.srem(this.key(organizationId), jobId);
  }

  async currentCount(organizationId: string): Promise<number> {
    return this.redis.scard(this.key(organizationId));
  }
}
