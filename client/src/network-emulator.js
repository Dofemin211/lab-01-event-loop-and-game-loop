export class NetworkEmulator {
  constructor({
    delayMs = 0,
    jitterMs = 0,
    lossPercent = 0,
    random = Math.random,
    now = () => globalThis.performance.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
  } = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    this.now = now;
    this.pending = new Set();
    this.deliveryQueues = new Map();
    this.nextDeliveryAt = new Map();
    this.configure({ delayMs, jitterMs, lossPercent });
  }

  configure({ delayMs, jitterMs, lossPercent }) {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) {
      throw new RangeError('Network delay must be between 0 and 1000 ms.');
    }
    if (!Number.isFinite(jitterMs) || jitterMs < 0 || jitterMs > 500) {
      throw new RangeError('Network jitter must be between 0 and 500 ms.');
    }
    if (!Number.isFinite(lossPercent) || lossPercent < 0 || lossPercent > 100) {
      throw new RangeError('Packet loss must be between 0 and 100 percent.');
    }
    this.delayMs = delayMs;
    this.jitterMs = jitterMs;
    this.lossPercent = lossPercent;
  }

  transmit(deliver, channel = 'default') {
    if (typeof deliver !== 'function') throw new TypeError('Network delivery must be a function.');
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('Network delivery channel must be a non-empty string.');
    }
    if (this.lossPercent >= 100 || this.random() * 100 < this.lossPercent) {
      return { dropped: true, delayMs: 0 };
    }
    const jitter = (this.random() * 2 - 1) * this.jitterMs;
    const now = this.now();
    const sampledDelay = Math.max(0, this.delayMs + jitter);
    const deliveryAt = Math.max(now + sampledDelay, this.nextDeliveryAt.get(channel) ?? now);
    const delayMs = deliveryAt - now;
    this.nextDeliveryAt.set(channel, deliveryAt);
    let queue = this.deliveryQueues.get(channel);
    if (delayMs === 0 && !queue?.length) {
      this.nextDeliveryAt.delete(channel);
      deliver();
      return { dropped: false, delayMs };
    }
    if (!queue) {
      queue = [];
      this.deliveryQueues.set(channel, queue);
    }
    queue.push({ deliver, deliveryAt });
    if (queue.length === 1) this.#scheduleNext(channel, queue);
    return { dropped: false, delayMs };
  }

  #scheduleNext(channel, queue) {
    const packet = queue[0];
    if (!packet) {
      this.deliveryQueues.delete(channel);
      this.nextDeliveryAt.delete(channel);
      return;
    }
    const timer = this.setTimer(
      () => {
        this.pending.delete(timer);
        if (this.deliveryQueues.get(channel) !== queue || queue[0] !== packet) return;
        queue.shift();
        try {
          packet.deliver();
        } finally {
          this.#scheduleNext(channel, queue);
        }
      },
      Math.max(0, packet.deliveryAt - this.now()),
    );
    this.pending.add(timer);
  }

  dispose() {
    for (const timer of this.pending) this.clearTimer(timer);
    this.pending.clear();
    this.deliveryQueues.clear();
    this.nextDeliveryAt.clear();
  }
}
