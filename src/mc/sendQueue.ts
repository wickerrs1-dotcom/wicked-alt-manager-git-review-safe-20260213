import { SEND_MIN_INTERVAL_MS } from "../constants";
import { sleep } from "../util/rand";

export class SendQueue {
  private lastSentAt = 0;
  private q: Array<() => Promise<void>> = [];
  private running = false;

  enqueue(fn: () => Promise<void>) {
    this.q.push(fn);
    void this.run();
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    while (this.q.length) {
      const fn = this.q.shift()!;
      const now = Date.now();
      const wait = Math.max(0, SEND_MIN_INTERVAL_MS - (now - this.lastSentAt));
      if (wait) await sleep(wait);
      try {
        await fn();
      } catch (e) {
        // Silent fail - message will be lost, but prevents queue from blocking
      }
      this.lastSentAt = Date.now();
    }
    this.running = false;
  }
}
