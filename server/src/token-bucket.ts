export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly now: () => number;
  tokens: number;
  lastRefillAt: number;

  constructor(capacity: number, refillPerSecond = capacity, now: () => number = Date.now) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError('Token bucket capacity must be positive.');
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError('Token refill rate must be positive.');
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.lastRefillAt = now();
  }

  consume(cost = 1): boolean {
    if (!Number.isFinite(cost) || cost <= 0 || cost > this.capacity) {
      throw new RangeError('Token cost must be positive and no greater than capacity.');
    }
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillAt = Math.max(this.lastRefillAt, now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
