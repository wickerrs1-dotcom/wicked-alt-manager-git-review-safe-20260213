import mc from "minecraft-protocol";
import path from "path";
import fs from "fs";
import { Logger } from "../util/logger";
import { randInt, sleep } from "../util/rand";
import { extractTextFromChat } from "../util/chat";
import {
  MC_VERSION,
  CONNECT_TIMEOUT_MS,
  HUB_JOIN_DELAY_MIN_MS,
  HUB_JOIN_DELAY_MAX_MS,
  BACKOFF_AUTH_MIN_MS, BACKOFF_AUTH_MAX_MS,
  BACKOFF_KICK_MIN_MS, BACKOFF_KICK_MAX_MS,
  BACKOFF_SOCKET_MIN_MS, BACKOFF_SOCKET_MAX_MS
} from "../constants";
import { SendQueue } from "./sendQueue";

export type ServerKey = "A" | "B";
export type AltStatus = "DISABLED" | "OFFLINE" | "CONNECTING" | "ONLINE" | "RECONNECTING" | "BACKOFF";

export type ChatEvent = { server: ServerKey; from: string; text: string };

export class AltSession {
  public slotNumber: number = 0;
  public username: string | undefined;
  public uuid: string | undefined;
  public status: AltStatus = "OFFLINE";
  public reason: string = "offline";
  public nextRetryAt: number | undefined;
  public nextAfkAt: number = 0;
  public lastPostedStatus: AltStatus = "OFFLINE"; // Track last Discord status post to avoid spam
  public onlineSinceAt: number | undefined;
  public disconnectCount = 0;
  public kickCount = 0;
  public errorCount = 0;

  private client: any | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private sendQueue = new SendQueue();
  private lastLoginHandledAt = 0;

  constructor(
    public readonly email: string,
    public readonly accountId: string,
    private readonly legacyCacheKey: string,
    public server: { host: string; port: number; joinCommand: string; key: ServerKey },
    public enabled: boolean,
    private logger: Logger,
    private onChat?: (ev: ChatEvent) => void
  ) {}

  public isOnline() { return this.status === "ONLINE"; }

  public async connect() {
    if (!this.enabled) {
      this.status = "DISABLED";
      this.reason = "disabled";
      return;
    }
    if (this.client) return;
    this.status = "CONNECTING";
    this.reason = `connecting ${this.server.host}`;
    this.lastLoginHandledAt = 0;
    this.logger.sys(`[MC] ${this.accountId} CONNECTING -> ${this.server.key} (${this.server.host})`);

    // Use hashed accountId for auth cache path to avoid email leakage
    const profilesFolder = path.resolve(process.cwd(), "state", "auth-cache", this.safeKey());
    const legacyProfilesFolder = path.resolve(process.cwd(), "state", "auth-cache", this.legacyCacheKey);
    
    // Ensure cache directory exists for microsoft auth tokens to persist
    try {
      if (!fs.existsSync(profilesFolder) && fs.existsSync(legacyProfilesFolder)) {
        try {
          fs.renameSync(legacyProfilesFolder, profilesFolder);
          this.logger.sys(`[MC] Migrated legacy cache to secured key for ${this.accountId}`);
        } catch {
          // leave legacy in place if migration fails
        }
      }

      if (!fs.existsSync(profilesFolder)) {
        fs.mkdirSync(profilesFolder, { recursive: true });
        this.logger.sys(`[MC] Created auth cache for ${this.accountId}`);
      } else {
        const files = fs.readdirSync(profilesFolder);
        if (files.length > 0) {
          this.logger.sys(`[MC] Using cached tokens (${files.length} file(s)) for ${this.accountId}`);
        }
      }
    } catch (e) {
      this.logger.sys(`[MC] ${this.accountId} failed to create cache dir: ${e}`);
    }

    try {
      const c = mc.createClient({
        host: this.server.host,
        port: this.server.port,
        username: this.email,
        auth: "microsoft",
        profilesFolder,
        version: MC_VERSION
      });
      this.client = c;

      // Attach error handler immediately to avoid unhandled EventEmitter crashes
      c.on("error", (err: any) => {
        this.errorCount++;
        const msg = err?.message ? String(err.message) : String(err);
        this.reason = `error: ${msg}`;
        this.logger.sys(`[MC] ${this.displayName()} ERROR ${msg}`);
      });

      this.connectTimer = setTimeout(() => {
        this.logger.sys(`[MC] ${this.accountId} connect timeout; destroying socket`);
        this.reason = "connect timeout";
        this.safeDestroy();
        void this.scheduleReconnect("socket");
      }, CONNECT_TIMEOUT_MS);

      c.on("login", async () => {
        const now = Date.now();
        if (this.lastLoginHandledAt > 0 && now - this.lastLoginHandledAt < 15_000) {
          return;
        }
        this.lastLoginHandledAt = now;

        this.username = (c as any).username || this.username;
        this.uuid = (c as any).uuid || this.uuid;
        this.status = "ONLINE";
        this.reason = "online";
        this.onlineSinceAt = Date.now();
        this.logger.sys(`[MC] ${this.displayName()} ONLINE on ${this.server.key}`);
        this.logger.alt(this.displayName(), `ONLINE on ${this.server.key} ${this.server.host}`);
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }

        await sleep(randInt(HUB_JOIN_DELAY_MIN_MS, HUB_JOIN_DELAY_MAX_MS));
        this.sendChat(this.server.joinCommand);
      });

      c.on("packet", (data: any, meta: any) => {
        const name = meta?.name;
        if (!name) return;

        if (name === "login_success") {
          if (data?.username) this.username = data.username;
          if (data?.uuid) this.uuid = data.uuid;
        }

        // 1.8.9 chat packet is "chat"
        if (name === "chat") {
          const text = extractTextFromChat(data?.message ?? data);
          // Only send non-empty chat messages
          if (text && text.trim() && this.onChat) {
            this.onChat({ server: this.server.key, from: this.displayName(), text: text.trim() });
          }
        }

        if (name === "disconnect" || name === "kick_disconnect") {
          this.kickCount++;
          const msg = typeof data?.reason === "string" ? data.reason : JSON.stringify(data?.reason ?? data);
          this.reason = `kicked: ${msg}`;
        }
      });

      c.on("end", () => {
        this.disconnectCount++;
        this.onlineSinceAt = undefined;
        const r = this.reason || "socket end";
        this.logger.sys(`[MC] ${this.displayName()} END (${r})`);
        this.safeDestroy();
        void this.scheduleReconnect(r.includes("kicked") ? "kick" : "socket");
      });

    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      this.reason = `createClient error: ${msg}`;
      this.logger.sys(`[MC] ${this.accountId} createClient failed: ${msg}`);
      this.safeDestroy();
      await this.scheduleReconnect("auth");
    }
  }

  public stop(manualReason = "stopped") {
    this.enabled = false;
    this.reason = manualReason;
    this.status = "DISABLED";
    this.onlineSinceAt = undefined;
    this.nextRetryAt = undefined;
    this.safeDestroy();
  }

  public disconnect(reason = "disconnected") {
    this.reason = reason;
    this.onlineSinceAt = undefined;
    this.nextRetryAt = undefined;
    this.safeDestroy();
    if (this.enabled) {
      this.status = "OFFLINE";
    }
  }

  public start() {
    this.enabled = true;
    this.status = "OFFLINE";
    this.reason = "starting";
  }

  public getUptimeMs(): number {
    if (!this.onlineSinceAt) return 0;
    return Math.max(0, Date.now() - this.onlineSinceAt);
  }

  public getPingMs(): number | undefined {
    if (!this.client || this.status !== "ONLINE") return undefined;
    const c: any = this.client;
    const candidates = [c?.player?.ping, c?.latency, c?.ping];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.round(value);
      }
    }
    return undefined;
  }

  public sendChat(message: string) {
    if (!this.client || this.status !== "ONLINE") return false;
    this.sendQueue.enqueue(async () => {
      try {
        this.client!.write("chat", { message });
        this.logger.alt(this.displayName(), `SEND ${message}`);
      } catch (e) {
        this.logger.alt(this.displayName(), `SEND FAILED: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    });
    return true;
  }

  public safeKey(): string {
    return this.accountId;
  }

  public displayName(): string {
    return this.username || "UnknownAlt";
  }

  public safeDisplayName(): string {
    // For Discord: never show email address
    if (this.username) return this.username;
    if (this.slotNumber > 0) return `Slot ${this.slotNumber}`;
    return "Slot";
  }

  private safeDestroy() {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (!this.client) {
      this.status = this.enabled ? "OFFLINE" : "DISABLED";
      return;
    }
    try {
      // Keep existing listeners during shutdown to avoid unhandled late error emissions
      this.client.on?.("error", () => {});
      this.client.end?.();
      this.client.destroy?.();
    } catch {}
    this.client = null;
    this.status = this.enabled ? "OFFLINE" : "DISABLED";
  }

  public async scheduleReconnect(kind: "socket" | "kick" | "auth") {
    if (!this.enabled) {
      this.status = "DISABLED";
      return;
    }
    this.status = "BACKOFF";
    let min = BACKOFF_SOCKET_MIN_MS, max = BACKOFF_SOCKET_MAX_MS;
    if (kind === "kick") { min = BACKOFF_KICK_MIN_MS; max = BACKOFF_KICK_MAX_MS; }
    if (kind === "auth") { min = BACKOFF_AUTH_MIN_MS; max = BACKOFF_AUTH_MAX_MS; }
    const wait = randInt(min, max);
    this.nextRetryAt = Date.now() + wait;
    this.reason = `backoff ${Math.ceil(wait/60000)}m (${kind})`;
    this.logger.alt(this.displayName(), `RECONNECT scheduled in ${wait}ms (${kind})`);
  }

  public async tick(holdReconnect: boolean, killed: boolean) {
    if (killed) return;
    if (!this.enabled) {
      this.status = "DISABLED";
      return;
    }
    if (this.client) return;
    if (holdReconnect) return;
    if (!this.nextRetryAt) return;
    if (Date.now() >= this.nextRetryAt) {
      this.nextRetryAt = undefined;
      this.status = "RECONNECTING";
      this.reason = "reconnecting";
      await this.connect();
    }
  }
}
