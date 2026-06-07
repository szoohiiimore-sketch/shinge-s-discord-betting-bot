import type { Redis } from 'ioredis';

export class OddspapiQuotaTracker {
  private readonly _redis: Redis;
  private readonly _softLimit: number;
  private readonly _hardLimit: number;

  constructor(redis: Redis, softLimit: number, hardLimit: number) {
    this._redis = redis;
    this._softLimit = softLimit;
    this._hardLimit = hardLimit;
  }

  private _monthlyKey(): string {
    const now = new Date();
    return `oddspapi:quota:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  async incrementAndCheck(): Promise<number> {
    const luaScript = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return count
    `;
    const ttlSeconds = 31 * 86400;
    const result = await this._redis.eval(luaScript, 1, this._monthlyKey(), ttlSeconds);
    return result as number;
  }

  async decrement(): Promise<void> {
    await this._redis.decr(this._monthlyKey());
  }

  async forceExhaust(): Promise<void> {
    await this._redis.set(this._monthlyKey(), String(this._hardLimit), 'EX', 31 * 86400);
  }

  async getMonthlyUsage(): Promise<number> {
    const raw = await this._redis.get(this._monthlyKey());
    return raw ? parseInt(raw, 10) : 0;
  }

  getSoftLimit(): number { return this._softLimit; }
  getHardLimit(): number { return this._hardLimit; }
}