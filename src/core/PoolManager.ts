import { MAX_SLOTS, SERVERS, CONNECT_SPACING_MS, SERVER_A_ENABLED, SERVER_B_ENABLED } from "../constants";
import { Logger } from "../util/logger";
import { loadState, saveState, AltStateStore } from "../util/store";
import fs from "fs";
import path from "path";
import { sleep, randInt } from "../util/rand";
import { AltSession, ServerKey, ChatEvent, AltStatus } from "../mc/AltSession";
import { accountIdFromEmail, legacyCacheKeyFromEmail } from "../util/account";

type AccountEntry = { email: string; accountId: string; legacyCacheKey: string; enabled: boolean; server?: ServerKey };

export class PoolManager {
  public sessions: AltSession[] = [];
  private logger: Logger;
  private onChatCb: ((ev: ChatEvent) => void) | undefined;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public setChatCallback(cb: (ev: ChatEvent) => void) {
    this.onChatCb = cb;
  }

  private enabledServers(): ServerKey[] {
    const out: ServerKey[] = [];
    if (SERVER_A_ENABLED) out.push("A");
    if (SERVER_B_ENABLED) out.push("B");
    return out.length ? out : ["A"];
  }

  private pickAutoServer(aCount: number, bCount: number): ServerKey {
    const enabled = this.enabledServers();
    if (enabled.length === 1) return enabled[0];
    return aCount <= bCount ? "A" : "B";
  }

  public loadAccounts(): AccountEntry[] {
    const p = "accounts.json";
    if (!fs.existsSync(p)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as { alts?: unknown[] };
      if (!Array.isArray(data.alts)) return [];

      const seen = new Set<string>();
      const out: AccountEntry[] = [];
      for (const raw of data.alts) {
        if (!raw || typeof raw !== "object") continue;
        const alt = raw as { email?: unknown; enabled?: unknown; server?: unknown };
        if (typeof alt.email !== "string" || typeof alt.enabled !== "boolean") continue;

        const email = alt.email.trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const server = alt.server === "A" || alt.server === "B" ? alt.server : undefined;
        out.push({
          email,
          accountId: accountIdFromEmail(email),
          legacyCacheKey: legacyCacheKeyFromEmail(email),
          enabled: alt.enabled,
          server
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  public initSlots() {
    // Ensure auth cache directory exists for microsoft tokens to persist
    const cacheDir = path.resolve(process.cwd(), "state", "auth-cache");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      this.logger.sys(`[POOL] Auth cache dir created: ${cacheDir}`);
    } else {
      this.logger.sys(`[POOL] Auth cache dir exists: ${cacheDir}`);
    }
    
    const st = loadState();
    const accounts = this.loadAccounts();

    const slots: AltStateStore['slots'] = [];
    let aCount = 0, bCount = 0;

    for (let i = 0; i < accounts.length && i < MAX_SLOTS; i++) {
      const acc = accounts[i];
      const prior = st.slots.find(s => String(s.accountId) === acc.accountId);
      
      const enabled = this.enabledServers();
      const preferred = acc.server === "A" || acc.server === "B" ? acc.server : undefined;
      const priorServer = prior?.server === "A" || prior?.server === "B" ? prior.server : undefined;

      // Use preferred/prior server only if enabled, otherwise auto-pick from enabled set
      let server: ServerKey | undefined;
      if (preferred && enabled.includes(preferred)) server = preferred;
      else if (priorServer && enabled.includes(priorServer)) server = priorServer;
      else server = this.pickAutoServer(aCount, bCount);

      if (server === "A") aCount++; else bCount++;
      
      slots.push({
        accountId: acc.accountId,
        server,
        enabled: acc.enabled, // Use enabled flag from accounts.json
        username: prior?.username,
        uuid: prior?.uuid,
        status: prior?.status,
        reason: prior?.reason,
        nextRetryAt: prior?.nextRetryAt,
        lastSeenAt: prior?.lastSeenAt
      });
    }

    while (slots.length < MAX_SLOTS) {
      slots.push({ accountId: `RESERVED_SLOT_${slots.length+1}`, server: this.pickAutoServer(aCount, bCount), enabled: false, status: "RESERVED", reason: "reserved" });
    }

    st.slots = slots;
    if (typeof st.holdReconnect !== "boolean") st.holdReconnect = false;
    if (typeof st.killed !== "boolean") st.killed = false;
    saveState(st);

    this.sessions = [];
    for (let index = 0; index < st.slots.length; index++) {
      const s = st.slots[index];
      if (String(s.accountId).startsWith("RESERVED_SLOT_")) continue;
      const acc = accounts.find(a => a.accountId === s.accountId);
      if (!acc) continue;
      const server = s.server === "A" ? { ...SERVERS.A, key: "A" as const } : { ...SERVERS.B, key: "B" as const };
      const sess = new AltSession(acc.email, acc.accountId, acc.legacyCacheKey, server, !!s.enabled, this.logger, (ev) => this.onChatCb?.(ev));
      sess.slotNumber = index + 1;
      sess.username = s.username;
      sess.uuid = s.uuid;
      if (s.status) {
        const valid: AltStatus[] = ["DISABLED", "OFFLINE", "CONNECTING", "ONLINE", "RECONNECTING", "BACKOFF"];
        if (valid.includes(s.status as AltStatus)) sess.status = s.status as AltStatus;
      }
      if (s.reason) sess.reason = s.reason;
      if (s.nextRetryAt) sess.nextRetryAt = s.nextRetryAt;
      this.sessions.push(sess);
    }
  }

  public persist() {
    const st = loadState();
    for (const sess of this.sessions) {
      const slot = st.slots.find(s => String(s.accountId) === sess.accountId);
      if (!slot) continue;
      slot.server = sess.server.key;
      slot.enabled = sess.enabled;
      slot.username = sess.username;
      slot.uuid = sess.uuid;
      slot.status = sess.status;
      slot.reason = sess.reason;
      slot.nextRetryAt = sess.nextRetryAt;
      slot.lastSeenAt = Date.now();
    }
    saveState(st);
  }

  public findByNameOrEmail(key: string): AltSession | null {
    const k = key.toLowerCase();
    let s = this.sessions.find(x => x.accountId.toLowerCase() === k);
    if (s) return s;
    s = this.sessions.find(x => (x.username ?? "").toLowerCase() === k);
    if (s) return s;
    return null;
  }

  public findByUsernameOrSlot(key: string): AltSession | null {
    const raw = key.trim();
    if (!raw) return null;
    const k = raw.toLowerCase();

    const slotMatch = k.match(/^(?:slot)?\s*(\d{1,2})$/);
    if (slotMatch) {
      const idx = Number(slotMatch[1]);
      if (idx >= 1) {
        const bySlot = this.sessions.find(s => s.slotNumber === idx);
        if (bySlot) return bySlot;
      }
    }

    const byName = this.sessions.find(x => (x.username ?? "").toLowerCase() === k);
    if (byName) return byName;

    return null;
  }

  public listSlotsLines(): string[] {
    const st = loadState();
    const lines: string[] = [];
    for (let i = 0; i < st.slots.length; i++) {
      const slot: any = st.slots[i];
      const idx = String(i+1).padStart(2, "0");
      if (String(slot.accountId).startsWith("RESERVED_SLOT_")) {
        lines.push(`⚫ Slot ${idx}: RESERVED`);
        continue;
      }
      // Only show username, never email for security
      const name = slot.username || `Slot ${i + 1}`;
      const server = slot.server;
      const host = server === "A" ? SERVERS.A.host : SERVERS.B.host;
      const status = String(slot.status || (slot.enabled ? "OFFLINE" : "DISABLED"));
      const reason = slot.reason ? ` — ${slot.reason}` : "";
      const icon = status === "ONLINE" ? "🟢" : status === "CONNECTING" ? "🟡" : status === "RECONNECTING" ? "🟣" : status === "BACKOFF" ? "🟣" : (slot.enabled ? "🔴" : "⚫");
      lines.push(`${icon} Slot ${idx}: ${name} [${server} ${host}] ${status}${reason}`);
    }
    return lines;
  }

  public async startAll() {
    for (const sess of this.sessions) {
      if (!sess.enabled) continue;
      await sess.connect();
      await sleep(CONNECT_SPACING_MS);
      this.persist();
    }
  }

  public stopAll(reason="stopped all") {
    for (const s of this.sessions) s.disconnect(reason);
    this.persist();
  }

  public async tick() {
    const st = loadState();
    // anti-afk: safe /bal randomized 60-120s per alt (only when online)
    const now = Date.now();
    for (const s of this.sessions) {
      await s.tick(st.holdReconnect, st.killed);
      if (s.isOnline()) {
        if (s.nextAfkAt <= 0 || now >= s.nextAfkAt) {
          s.sendChat("/bal");
          s.nextAfkAt = now + randInt(60_000, 120_000);
        }
      }
    }
    this.persist();
  }

  public async move(target: AltSession, to: ServerKey, reconnectDelayMs = 15_000): Promise<boolean> {
    const from = target.server.key;
    if ((to === "A" && !SERVER_A_ENABLED) || (to === "B" && !SERVER_B_ENABLED)) {
      target.reason = `server ${to} is disabled in config`;
      this.persist();
      return false;
    }

    if (target.server.key === to) {
      target.reason = `already on ${to}`;
      this.persist();
      return true;
    }

    target.disconnect(`moving ${from} -> ${to}`);
    target.server = to === "A" ? { ...SERVERS.A, key: "A" as const } : { ...SERVERS.B, key: "B" as const };
    target.reason = `moved to ${to}; reconnecting in ${Math.ceil(reconnectDelayMs / 1000)}s`;
    this.persist();

    await sleep(reconnectDelayMs);
    if (!target.enabled) {
      this.persist();
      return true;
    }

    target.start();
    await target.connect();
    this.persist();
    return true;
  }

  public async balance() {
    if (SERVER_A_ENABLED && !SERVER_B_ENABLED) {
      for (const sess of this.sessions.filter(s => s.enabled && s.server.key !== "A")) {
        await this.move(sess, "A");
      }
      return;
    }
    if (SERVER_B_ENABLED && !SERVER_A_ENABLED) {
      for (const sess of this.sessions.filter(s => s.enabled && s.server.key !== "B")) {
        await this.move(sess, "B");
      }
      return;
    }

    const enabled = this.sessions.filter(s => s.enabled);
    let a = enabled.filter(s => s.server.key === "A").length;
    let b = enabled.filter(s => s.server.key === "B").length;

    for (const sess of enabled) {
      if (a > b + 1 && sess.server.key === "A") {
        await this.move(sess, "B");
        a--;
        b++;
      } else if (b > a && sess.server.key === "B") {
        await this.move(sess, "A");
        b--;
        a++;
      }
      if (Math.abs(a-b) <= 1 && a >= b) break;
    }
  }
}
