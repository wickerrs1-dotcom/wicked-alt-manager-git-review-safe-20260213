import { Client, GatewayIntentBits, Partials, TextChannel, EmbedBuilder, PermissionsBitField } from "discord.js";
import { spawn } from "child_process";
import path from "path";
import { DISCORD_ANNOUNCEMENTS_CHANNEL_ID, DISCORD_CONTROL_CHANNEL_ID, DISCORD_CONTROL_ROLE_ID, DISCORD_GRANDMASTER_USER_ID, DISCORD_PREFIX, APP_NAME, APP_VERSION } from "../constants";
import { PoolManager } from "../core/PoolManager";
import { Logger } from "../util/logger";
import { loadState, saveState } from "../util/store";
import { ChatEvent, ServerKey } from "../mc/AltSession";
import { sleep } from "../util/rand";

function hasControlRole(member: any): boolean {
  if (!member?.roles) return false;
  return member.roles.cache?.has(DISCORD_CONTROL_ROLE_ID) ?? false;
}

function isGrandMaster(userId: string): boolean {
  return userId === DISCORD_GRANDMASTER_USER_ID;
}

function chunkLines(lines: string[], maxChars = 3500): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of lines) {
    if ((buf + line + "\n").length > maxChars) {
      out.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf) out.push(buf);
  return out;
}

function getTargetSessions(pool: PoolManager, target: string, includeDisabled = false): { sessions: import("../mc/AltSession").AltSession[], count: number } | null {
  const t = target.toLowerCase();
  if (t === "all") return { sessions: pool.sessions.filter(s => includeDisabled || s.enabled), count: -1 };
  if (t === "a") return { sessions: pool.sessions.filter(s => (includeDisabled || s.enabled) && s.server.key === "A"), count: -1 };
  if (t === "b") return { sessions: pool.sessions.filter(s => (includeDisabled || s.enabled) && s.server.key === "B"), count: -1 };
  const session = pool.findByUsernameOrSlot(target);
  if (!session) return null;
  if (!includeDisabled && !session.enabled) return null;
  return { sessions: [session], count: 1 };
}

function normalizeMinecraftCommand(raw: string): string {
  const text = raw.trim();
  if (!text) return "";

  const quick: Record<string, string> = {
    tpyes: "/tpyes",
    fhome: "/f home",
    ftop: "/f top",
    fshow: "/f show",
    spawn: "/spawn",
    home: "/home",
    bal: "/bal"
  };

  const key = text.toLowerCase();
  if (quick[key]) return quick[key];
  return text.startsWith("/") ? text : `/${text}`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

export class DiscordControl {
  private client: Client;
  private controlChannel: TextChannel | null = null;
  private statusCheckInterval: NodeJS.Timeout | null = null;
  private chatFlushInterval: NodeJS.Timeout | null = null;
  private commandDedupe = new Map<string, number>();
  private statusBroadcastEnabled = true;
  private chatBroadcastEnabled = true;
  private lastStatusByAccount = new Map<string, { key: string; at: number }>();
  private lastChatByKey = new Map<string, number>();
  private chatBuffer: Array<{ server: "A" | "B"; from: string; text: string }> = [];
  private chatBufferFirstAt: number | undefined;
  private pendingActionCaptures = new Map<string, {
    channel: TextChannel;
    title: string;
    ign: string;
    payload: string;
    servers: Set<ServerKey>;
    maxLines: number;
    lines: string[];
    timeout: NodeJS.Timeout;
  }>();

  private static readonly CHAT_FLUSH_EVERY_MS = 10_000;
  private static readonly CHAT_MIN_LINES = 5;
  private static readonly CHAT_MAX_LINES = 10;
  private static readonly DISCORD_MAX_BULK_DELETE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

  constructor(private pool: PoolManager, private logger: Logger) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel]
    });
  }

  public isReady(): boolean {
    return this.controlChannel !== null;
  }

  public async runInternalCommandAsGM(content: string): Promise<boolean> {
    if (!this.controlChannel) return false;
    const fakeMsg: any = {
      author: { bot: false, id: DISCORD_GRANDMASTER_USER_ID, tag: "SELFTEST" },
      channelId: DISCORD_CONTROL_CHANNEL_ID,
      content,
      member: { roles: { cache: { has: (_id: string) => true } } },
      channel: this.controlChannel
    };
    this.client.emit("messageCreate", fakeMsg);
    return true;
  }

  private startStatusCheck() {
    if (this.statusCheckInterval) return;
    // Check for status changes with anti-spam dedupe
    this.statusCheckInterval = setInterval(() => {
      for (const sess of this.pool.sessions) {
        if (!this.statusBroadcastEnabled) continue;
        if (!sess.enabled) continue;
        const key = `${sess.status}|${sess.reason}`;
        const prior = this.lastStatusByAccount.get(sess.accountId);
        const now = Date.now();
        const cooldownMs = 15_000;
        if (!prior || prior.key !== key) {
          if (!prior || now - prior.at >= cooldownMs) {
            void this.postStatus(sess.safeDisplayName(), sess.status, sess.reason);
            this.lastStatusByAccount.set(sess.accountId, { key, at: now });
          }
        }
      }
    }, 8_000);
  }

  private startChatFlush() {
    if (this.chatFlushInterval) return;
    this.chatFlushInterval = setInterval(() => {
      void this.flushChatBuffer();
    }, DiscordControl.CHAT_FLUSH_EVERY_MS);
  }

  private async flushChatBuffer() {
    if (!this.controlChannel) return;
    if (!this.chatBuffer.length) return;

    const sendBatchForServer = async (server: "A" | "B", title: string) => {
      const serverEntries = this.chatBuffer.filter((entry) => entry.server === server);
      if (serverEntries.length < DiscordControl.CHAT_MIN_LINES) return;

      const take = Math.min(DiscordControl.CHAT_MAX_LINES, serverEntries.length);
      const batch = serverEntries.slice(0, take);
      let removed = 0;
      this.chatBuffer = this.chatBuffer.filter((entry) => {
        if (entry.server !== server) return true;
        if (removed < take) {
          removed++;
          return false;
        }
        return true;
      });

      const lines = batch.map((entry) => `• ${entry.from} » ${entry.text}`);
      const sections = [
        `${title} (${lines.length})`,
        ...lines
      ];
      const payload = sections.join("\n");

      try {
        await this.controlChannel!.send({ content: payload.slice(0, 3900) });
      } catch (e) {
        this.logger.sys(`[DISCORD] Failed to flush chat (${server}): ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    await sendBatchForServer("A", "Server A");
    await sendBatchForServer("B", "Server B");
    this.chatBufferFirstAt = this.chatBuffer.length ? Date.now() : undefined;
  }

  async start() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      this.logger.sys("[DISCORD] DISCORD_TOKEN not set; Discord control disabled.");
      return;
    }

    this.client.on("clientReady", async () => {
      this.logger.sys(`[DISCORD] ✓ Connected: ${this.client.user?.tag}`);
      const ch = await this.client.channels.fetch(DISCORD_CONTROL_CHANNEL_ID).catch(() => null);
      if (ch && ch.isTextBased()) {
        this.controlChannel = ch as TextChannel;
        this.startStatusCheck();
        this.startChatFlush();
      }
    });

    this.client.on("messageCreate", async (msg) => {
      try {
        if (msg.author.bot) return;
        if (msg.channelId !== DISCORD_CONTROL_CHANNEL_ID) return;
        const gm = isGrandMaster(msg.author.id);
        const hasRole = hasControlRole(msg.member);
        if (!gm && !hasRole) return;

        const content = msg.content.trim();

        if (content.toLowerCase().startsWith(".dmall")) {
          if (!gm) return void this.reply(msg.channel as TextChannel, "Only Grand Master can use `.dmall`.");
          const text = content.slice(6).trim();
          if (!text) return void this.reply(msg.channel as TextChannel, "Usage: `.dmall <message>`");
          return void this.handleDmall(msg.channel as TextChannel, msg, text);
        }

        if (content.toLowerCase().startsWith(".annoucements") || content.toLowerCase().startsWith(".announcements")) {
          if (!gm) return void this.reply(msg.channel as TextChannel, "Only Grand Master can use announcement broadcast.");
          const raw = content.toLowerCase().startsWith(".annoucements")
            ? content.slice(".annoucements".length).trim()
            : content.slice(".announcements".length).trim();
          if (!raw) return void this.reply(msg.channel as TextChannel, "Usage: `.annoucements <message>`");
          return void this.handleAnnouncement(msg.channel as TextChannel, msg, raw);
        }

        if (content.toLowerCase().startsWith(".purge")) {
          const countRaw = content.slice(".purge".length).trim() || "50";
          const count = Math.max(1, Math.min(100, Number.parseInt(countRaw, 10) || 50));
          const channel = msg.channel as TextChannel;
          try {
            const me = this.client.user;
            if (!me) return void this.reply(channel, "Bot is not ready yet.");
            const perms = channel.permissionsFor(me);
            if (!perms?.has(PermissionsBitField.Flags.ManageMessages)) {
              return void this.reply(channel, "Missing permission: Manage Messages in this channel.");
            }

            const fetched = await channel.messages.fetch({ limit: Math.min(100, count + 25) });
            const candidates = [...fetched.values()]
              .filter(m => !m.pinned)
              .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
              .slice(0, count);

            const nowMs = Date.now();
            const recent = candidates.filter(m => nowMs - m.createdTimestamp < DiscordControl.DISCORD_MAX_BULK_DELETE_AGE_MS);
            const older = candidates.filter(m => nowMs - m.createdTimestamp >= DiscordControl.DISCORD_MAX_BULK_DELETE_AGE_MS);

            let deletedRecent = 0;
            let deletedOlder = 0;

            if (recent.length) {
              const deleted = await channel.bulkDelete(recent.map((m) => m.id), true);
              deletedRecent = deleted.size;
            }

            for (const oldMsg of older) {
              try {
                await oldMsg.delete();
                deletedOlder++;
              } catch {}
            }

            const totalDeleted = deletedRecent + deletedOlder;
            return void this.reply(channel, `Purged ${totalDeleted} message(s).`);
          } catch (e) {
            this.logger.sys(`[DISCORD] purge failed: ${e instanceof Error ? e.message : String(e)}`);
            return void this.reply(channel, "Failed to purge messages (messages older than 14 days cannot be bulk deleted).");
          }
        }

        if (content.toLowerCase() === ".restart" || content.toLowerCase().startsWith(".restart ")) {
          if (!gm) return void this.reply(msg.channel as TextChannel, "Only Grand Master can use `.restart`.");
          await this.reply(msg.channel as TextChannel, "Restarting bot process now...");
          this.logger.sys(`[DISCORD] Full process restart requested by ${msg.author?.tag ?? msg.author?.id ?? "unknown"}`);
          setTimeout(() => {
            try {
              const entry = path.resolve(process.cwd(), "dist", "index.js");
              if (process.platform === "win32") {
                const delayedCmd = `Start-Sleep -Seconds 2; node \"${entry}\"`;
                spawn("powershell.exe", ["-NoProfile", "-Command", delayedCmd], {
                  cwd: process.cwd(),
                  detached: true,
                  stdio: "ignore"
                }).unref();
              } else {
                const delayedCmd = `sleep 2; node \"${entry}\"`;
                spawn("sh", ["-c", delayedCmd], {
                  cwd: process.cwd(),
                  detached: true,
                  stdio: "ignore"
                }).unref();
              }
            } catch (e) {
              this.logger.sys(`[DISCORD] restart spawn failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            process.exit(0);
          }, 1200);
          return;
        }

        const prefix = DISCORD_PREFIX.toLowerCase();
        if (!content.toLowerCase().startsWith(prefix)) return;

        const dedupeKey = `${msg.author.id}|${content.toLowerCase()}`;
        const now = Date.now();
        const seenAt = this.commandDedupe.get(dedupeKey) ?? 0;
        if (now - seenAt < 2500) return;
        this.commandDedupe.set(dedupeKey, now);

        const cmdText = content.slice(prefix.length).trim();
        const parts = cmdText.split(/\s+/);
        const sub = (parts[0] || "").toLowerCase();

        const nonOpAllowed = new Set([
          "help", "list", "slots", "status", "say", "cmd", "health", "perms",
          "tpyes", "fhome", "ftop", "fshow", "spawn", "home", "bal", "examples"
        ]);
        if (!gm && !nonOpAllowed.has(sub)) {
          return void this.reply(msg.channel as TextChannel, "You have control access, but this command is OP-only.");
        }

        if (!sub || sub === "help") return void this.sendHelp(msg.channel as TextChannel);

        if (sub === "list" || sub === "slots") return void this.sendList(msg.channel as TextChannel);

        if (sub === "perms") {
          const roleMention = `<@&${DISCORD_CONTROL_ROLE_ID}>`;
          const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle("🛡️ Role Permissions")
            .setDescription(`Role: ${roleMention}`)
            .addFields([
              {
                name: "✅ Allowed",
                value: [
                  "`.alts help`",
                  "`.alts perms`",
                  "`.alts health`",
                  "`.alts list` / `.alts slots`",
                  "`.alts status <all|name|slot#>`",
                  "`.alts say <ign> <message>`",
                  "`.alts cmd <ign> </command>`",
                  "`.alts tpyes [ign]`",
                  "`.alts fhome [ign]` / `.alts ftop [ign]` / `.alts fshow [ign]`",
                  "`.alts spawn [ign]` / `.alts home [ign]` / `.alts bal [ign]"
                ].join("\n")
              },
              {
                name: "⛔ Not Allowed",
                value: [
                  "`.alts start` / `.alts stop` / `.alts restart`",
                  "`.alts enable` / `.alts disable`",
                  "`.alts move` / `.alts balance`",
                  "`.alts hold` / `.alts resume` / `.alts kill`",
                  "`.alts watch ...`"
                ].join("\n")
              }
            ])
            .setFooter({ text: "Grand Master has full command access." });

          try {
            await (msg.channel as TextChannel).send({ embeds: [embed] });
          } catch (e) {
            this.logger.sys(`[DISCORD] Failed to send perms: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }

        if (sub === "health") {
          const total = this.pool.sessions.length;
          const enabled = this.pool.sessions.filter(s => s.enabled).length;
          const disabled = total - enabled;
          const online = this.pool.sessions.filter(s => s.status === "ONLINE").length;
          const connecting = this.pool.sessions.filter(s => s.status === "CONNECTING" || s.status === "RECONNECTING").length;
          const backoff = this.pool.sessions.filter(s => s.status === "BACKOFF").length;
          const offlineEnabled = this.pool.sessions.filter(s => s.enabled && s.status === "OFFLINE").length;
          const onlineA = this.pool.sessions.filter(s => s.enabled && s.server.key === "A" && s.status === "ONLINE").length;
          const onlineB = this.pool.sessions.filter(s => s.enabled && s.server.key === "B" && s.status === "ONLINE").length;
          const routedA = this.pool.sessions.filter(s => s.enabled && s.server.key === "A").length;
          const routedB = this.pool.sessions.filter(s => s.enabled && s.server.key === "B").length;
          const pingValues = this.pool.sessions
            .filter(s => s.enabled && s.status === "ONLINE")
            .map(s => s.getPingMs())
            .filter((v): v is number => typeof v === "number");
          const avgPing = pingValues.length ? Math.round(pingValues.reduce((a, b) => a + b, 0) / pingValues.length) : undefined;
          const totalDisconnects = this.pool.sessions.reduce((n, s) => n + s.disconnectCount, 0);
          const totalKicks = this.pool.sessions.reduce((n, s) => n + s.kickCount, 0);
          const totalErrors = this.pool.sessions.reduce((n, s) => n + s.errorCount, 0);
          const topUptime = this.pool.sessions
            .filter(s => s.isOnline())
            .sort((a, b) => b.getUptimeMs() - a.getUptimeMs())[0];
          const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle("🩺 Alt Pool Health")
            .addFields([
              { name: "Sessions", value: `Online ${online}/${enabled}\nEnabled ${enabled} • Disabled ${disabled}\nOffline ${offlineEnabled}`, inline: true },
              { name: "Transit", value: `Connecting ${connecting}\nBackoff ${backoff}\nAvg Ping ${avgPing !== undefined ? `${avgPing}ms` : "-"}`, inline: true },
              { name: "Routing", value: `A ${onlineA}/${routedA} online\nB ${onlineB}/${routedB} online`, inline: true },
              { name: "Stability", value: `Disconnects ${totalDisconnects}\nKicks ${totalKicks}\nErrors ${totalErrors}`, inline: true },
              { name: "Longest Uptime", value: topUptime ? `${topUptime.safeDisplayName()} • ${formatDuration(topUptime.getUptimeMs())}` : "-", inline: true },
              { name: "Watchers", value: `Status ${this.statusBroadcastEnabled ? "on" : "off"}\nChat ${this.chatBroadcastEnabled ? "on" : "off"}`, inline: true }
            ]);
          return void (msg.channel as TextChannel).send({ embeds: [embed] });
        }

        if (sub === "examples") {
          const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("📚 Command Examples")
            .setDescription("Quick examples for the main features")
            .addFields([
              { name: "Announcements", value: "`.annoucements Server maintenance starts in 15 minutes.`" },
              { name: "DM All", value: "`.dmall Hello everyone — check #rules before joining events.`" },
              { name: "Say (chat)", value: "`.alts say all Selling blaze spawners, DM offers.`" },
              { name: "Command", value: "`.alts cmd all /f who MyFaction`" },
              { name: "Quick Factions", value: "`.alts tpyes all`  |  `.alts fhome A`  |  `.alts spawn B`" },
              { name: "Sessions", value: "`.alts list`  |  `.alts status all`  |  `.alts status 136L`" },
              { name: "Control", value: "`.alts start all`  |  `.alts restart A`  |  `.alts watch chat off`" },
              { name: "Discord", value: "`.purge 25`  |  `.annoucements <message>`  |  `.dmall <message>`" }
            ])
            .setFooter({ text: "Use .alts perms to see role limitations." });
          try {
            await (msg.channel as TextChannel).send({ embeds: [embed] });
          } catch (e) {
            this.logger.sys(`[DISCORD] Failed to send examples: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }

        if (sub === "status") {
          const key = parts[1];
          if (!key) return void this.reply(msg.channel as TextChannel, "Usage: `.alts status <all|ign|slot#>`");
          if (key.toLowerCase() === "all") {
            const lines = this.pool.sessions.map((s) => {
              const icon = s.status === "ONLINE" ? "🟢" : s.status === "CONNECTING" ? "🟡" : s.status === "RECONNECTING" || s.status === "BACKOFF" ? "🟣" : (s.enabled ? "🔴" : "⚫");
              const ping = s.getPingMs();
              const up = s.isOnline() ? formatDuration(s.getUptimeMs()) : "-";
              const conciseReason = s.reason === "online" ? "Connected and stable" : s.reason;
              return `${icon} ${s.safeDisplayName()} [${s.server.key} ${s.server.host}] ${s.status} | ping=${ping ?? "-"}ms | up=${up} | disc=${s.disconnectCount} kick=${s.kickCount} err=${s.errorCount} — ${conciseReason}`;
            });
            const chunks = chunkLines(lines, 1800);
            for (const chunk of chunks) {
              const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle("🔍 Alt Status")
                .setDescription(`\`\`\`\n${chunk}\n\`\`\``);
              await (msg.channel as TextChannel).send({ embeds: [embed] });
            }
            return;
          }
          const s = this.pool.findByUsernameOrSlot(key);
          if (!s) return void this.reply(msg.channel as TextChannel, "Not found.");
          const host = s.server.host;
          const ping = s.getPingMs();
          const uptime = s.isOnline() ? formatDuration(s.getUptimeMs()) : "-";
          const conciseReason = s.reason === "online" ? "Connected and stable" : s.reason;
          const embed = new EmbedBuilder()
            .setColor(s.status === "ONLINE" ? 0x57F287 : s.status === "CONNECTING" || s.status === "RECONNECTING" ? 0xFEE75C : 0xED4245)
            .setTitle(`🔍 ${s.safeDisplayName()}`)
            .addFields([
              { name: "Route", value: `${s.server.key} • ${host}`, inline: true },
              { name: "State", value: s.status, inline: true },
              { name: "Enabled", value: s.enabled ? "Yes" : "No", inline: true },
              { name: "Ping", value: ping !== undefined ? `${ping}ms` : "-", inline: true },
              { name: "Uptime", value: uptime, inline: true },
              { name: "Drops", value: `disconnect=${s.disconnectCount} | kick=${s.kickCount} | error=${s.errorCount}` },
              { name: "Detail", value: conciseReason }
            ]);
          return void (msg.channel as TextChannel).send({ embeds: [embed] });
        }

        if (sub === "start" || sub === "stop" || sub === "restart") {
          const target = (parts[1] || "").toLowerCase();
          if (!target) return void this.reply(msg.channel as TextChannel, `Usage: \`.alts ${sub} <ign|slot#|all|A|B>\``);

          const result = getTargetSessions(this.pool, target, sub === "start");
          if (!result) return void this.reply(msg.channel as TextChannel, "Not found.");

          const set = result.sessions;
          if (sub === "stop") set.forEach(s => s.stop("stopped by discord"));
          if (sub === "start") { set.forEach(s => s.start()); for (const s of set) await s.connect(); }
          if (sub === "restart") { set.forEach(s => s.stop("restart by discord")); set.forEach(s => s.start()); for (const s of set) await s.connect(); }
          this.pool.persist();
          const count = result.count === -1 ? set.length : "1";
          this.logger.sys(`[DISCORD] ${sub} command: ${count} alt(s) (target: ${target})`);
          return void this.reply(msg.channel as TextChannel, `OK: ${sub} (${set.length} alt${set.length === 1 ? "" : "s"})`);
        }

        if (sub === "say") {
          const ign = parts[1];
          const message = parts.slice(2).join(" ");
          if (!ign || !message) return void this.reply(msg.channel as TextChannel, "Usage: `.alts say <all|A|B|ign|slot#> <message>`");
          if (message.length > 256) return void this.reply(msg.channel as TextChannel, "Message too long (max 256 chars)");

          const force = message.includes("--force");
          const msgText = message.replace("--force", "").trim();
          if (!msgText) return void this.reply(msg.channel as TextChannel, "Message is empty after removing flags");

          const result = getTargetSessions(this.pool, ign);
          if (!result) return void this.reply(msg.channel as TextChannel, "Not found.");

          const set = result.sessions.filter(s => force || s.isOnline());
          if (!set.length) return void this.reply(msg.channel as TextChannel, "No online alts matched for this request.");
          this.startActionCapture(
            msg.channel as TextChannel,
            "Chat Response",
            ign,
            msgText,
            [...new Set(set.map(s => s.server.key))],
            6,
            set.slice(0, 4).map(s => `${s.safeDisplayName()} » ${msgText}`)
          );
          set.forEach(s => s.sendChat(msgText));
          this.logger.sys(`[DISCORD] say: "${msgText}" to ${set.length} alt(s) (target: ${ign})`);
          await this.sendChatActionResult(msg.channel as TextChannel, "Chat Sent", ign, msgText, set.map(s => s.safeDisplayName()));
          return;
        }

        if (sub === "cmd") {
          let ign = (parts[1] || "").trim();
          let raw = parts.slice(2).join(" ").trim();

          // MCC-like convenience:
          // .alts cmd tpyes            -> target=all, cmd=tpyes
          // .alts cmd all tpyes        -> target=all, cmd=tpyes
          // .alts cmd 136L tpyes       -> target=136L, cmd=tpyes
          if (!raw && ign) {
            raw = ign;
            ign = "all";
          }

          if (!ign || !raw) return void this.reply(msg.channel as TextChannel, "Usage: `.alts cmd <all|A|B|ign|slot#> <command>` (ex: `.alts cmd all tpyes`)");
          const commandText = normalizeMinecraftCommand(raw);
          if (!commandText) return void this.reply(msg.channel as TextChannel, "Command is empty.");
          if (commandText.length > 256) return void this.reply(msg.channel as TextChannel, "Command too long (max 256 chars)");

          const result = getTargetSessions(this.pool, ign);
          if (!result) return void this.reply(msg.channel as TextChannel, "Not found.");

          const set = result.sessions.filter(s => s.isOnline());
          if (!set.length) return void this.reply(msg.channel as TextChannel, "No online alts matched for this request.");
          this.startActionCapture(
            msg.channel as TextChannel,
            "Command Response",
            ign,
            commandText,
            [...new Set(set.map(s => s.server.key))],
            30,
            set.slice(0, 4).map(s => `${s.safeDisplayName()} » ${commandText}`)
          );
          set.forEach(s => s.sendChat(commandText));
          this.logger.sys(`[DISCORD] cmd: "${commandText}" to ${set.length} alt(s) (target: ${ign})`);
          await this.sendChatActionResult(msg.channel as TextChannel, "Command Sent", ign, commandText, set.map(s => s.safeDisplayName()));
          return;
        }

        const quickCommands: Record<string, string> = {
          tpyes: "/tpyes",
          fhome: "/f home",
          ftop: "/f top",
          fshow: "/f show",
          spawn: "/spawn",
          home: "/home",
          bal: "/bal"
        };

        if (Object.prototype.hasOwnProperty.call(quickCommands, sub)) {
          const target = (parts[1] || "all").toLowerCase();
          const result = getTargetSessions(this.pool, target);
          if (!result) return void this.reply(msg.channel as TextChannel, "Not found.");
          const set = result.sessions.filter(s => s.isOnline());
          const commandText = quickCommands[sub];
          set.forEach(s => s.sendChat(commandText));
          this.logger.sys(`[DISCORD] quickcmd: "${commandText}" to ${set.length} alt(s) (target: ${target})`);
          return void this.reply(msg.channel as TextChannel, `Sent ${commandText} to ${set.length} alt${set.length === 1 ? "" : "s"}.`);
        }

        if (sub === "move") {
          const target = parts[1];
          const dest = (parts[2] || "").toUpperCase();
          if (!target || (dest !== "A" && dest !== "B")) return void this.reply(msg.channel as TextChannel, "Usage: `.alts move <ign|slot#|all> <A|B>`");

          const result = getTargetSessions(this.pool, target);
          if (!result) return void this.reply(msg.channel as TextChannel, "Not found.");

          const set = result.sessions;
          let moved = 0;
          let skipped = 0;
          for (const s of set) {
            const ok = await this.pool.move(s, dest as "A" | "B", 15_000);
            if (ok) moved++; else skipped++;
          }
          this.logger.sys(`[DISCORD] move: moved=${moved}, skipped=${skipped}, dest=${dest}, target=${target}`);
          if (moved === 0 && skipped > 0) {
            return void this.reply(msg.channel as TextChannel, `No alts moved. Server ${dest} is disabled in config.`);
          }
          const skipText = skipped > 0 ? `, skipped ${skipped}` : "";
          return void this.reply(msg.channel as TextChannel, `Moved ${moved} alt${moved === 1 ? "" : "s"} to ${dest}${skipText} (disconnect -> 15s wait -> reconnect).`);
        }

        if (sub === "balance") {
          await this.pool.balance();
          this.logger.sys("[DISCORD] balance command executed");
          return void this.reply(msg.channel as TextChannel, "Balance applied.");
        }

        if (sub === "enable" || sub === "disable") {
          const target = (parts[1] || "").toLowerCase();
          if (!target) return void this.reply(msg.channel as TextChannel, "Usage: `.alts enable|disable <all|A|B|ign|slot#>`");
          const result = getTargetSessions(this.pool, target, sub === "enable");
          if (!result) return void this.reply(msg.channel as TextChannel, "Not found.");
          const set = result.sessions;
          if (sub === "enable") {
            set.forEach(s => s.start());
          } else {
            set.forEach(s => s.stop("disabled by discord"));
          }
          this.pool.persist();
          this.logger.sys(`[DISCORD] ${sub}: ${set.length} alt(s) (target: ${target})`);
          return void this.reply(msg.channel as TextChannel, `${sub === "enable" ? "Enabled" : "Disabled"} ${set.length} alt${set.length === 1 ? "" : "s"}.`);
        }

        if (sub === "watch") {
          const scope = (parts[1] || "").toLowerCase();
          const mode = (parts[2] || "").toLowerCase();

          if (scope === "status" || scope === "chat" || scope === "all") {
            if (mode !== "on" && mode !== "off") {
              return void this.reply(msg.channel as TextChannel, "Usage: `.alts watch <status|chat|all> <on|off>`");
            }
            const on = mode === "on";
            if (scope === "status" || scope === "all") this.statusBroadcastEnabled = on;
            if (scope === "chat" || scope === "all") this.chatBroadcastEnabled = on;
            return void this.reply(msg.channel as TextChannel, `Watch updated: status=${this.statusBroadcastEnabled ? "on" : "off"}, chat=${this.chatBroadcastEnabled ? "on" : "off"}`);
          }

          if (scope === "on" || scope === "off") {
            const on = scope === "on";
            this.statusBroadcastEnabled = on;
            this.chatBroadcastEnabled = on;
            return void this.reply(msg.channel as TextChannel, `Watch updated: status=${this.statusBroadcastEnabled ? "on" : "off"}, chat=${this.chatBroadcastEnabled ? "on" : "off"}`);
          }

          return void this.reply(msg.channel as TextChannel, "Usage: `.alts watch <status|chat|all> <on|off>`");
        }

        if (sub === "hold" || sub === "resume" || sub === "kill") {
          const st = loadState();
          if (sub === "hold") { 
            st.holdReconnect = true; 
            saveState(st); 
            this.logger.sys("[DISCORD] reconnect HOLD enabled");
            return void this.reply(msg.channel as TextChannel, "HOLD enabled: online alts stay online, but disconnected alts will not reconnect until resume."); 
          }
          if (sub === "resume") { 
            st.holdReconnect = false; 
            st.killed = false; 
            saveState(st); 
            this.logger.sys("[DISCORD] reconnect RESUMED");
            return void this.reply(msg.channel as TextChannel, "RESUME enabled: reconnect loop is active again."); 
          }
          if (sub === "kill") { 
            st.killed = true; 
            saveState(st); 
            this.pool.stopAll("killed"); 
            this.logger.sys("[DISCORD] KILL switch activated");
            return void this.reply(msg.channel as TextChannel, "KILL enabled: all alts disconnected now, reconnect blocked until resume."); 
          }
        }

        return void this.reply(msg.channel as TextChannel, "Unknown command. Type `.alts` for help.");
      } catch (e: any) {
        this.logger.sys(`[DISCORD] handler error: ${e?.message ?? e}`);
      }
    });

    await this.client.login(token);
  }

  public async postChat(ev: ChatEvent) {
    if (!this.controlChannel) return;
    if (!ev.text || !ev.text.trim()) return;

    const normalized = ev.text.replace(/\s+/g, " ").trim();
    if (!normalized || normalized === '""' || normalized === "''") return;

    const text = normalized;

    for (const [key, capture] of this.pendingActionCaptures) {
      if (!capture.servers.has(ev.server)) continue;
      capture.lines.push(`${ev.from} » ${text}`);
      if (capture.lines.length >= capture.maxLines) {
        clearTimeout(capture.timeout);
        this.pendingActionCaptures.delete(key);
        await this.flushActionCapture(capture);
      }
    }

    if (!this.chatBroadcastEnabled) return;

    const dedupeKey = `${ev.server}|${ev.from}|${normalized}`;
    const now = Date.now();
    const lastAt = this.lastChatByKey.get(dedupeKey) ?? 0;
    if (now - lastAt < 10_000) return;
    this.lastChatByKey.set(dedupeKey, now);

    if (!this.chatBufferFirstAt) this.chatBufferFirstAt = Date.now();
    this.chatBuffer.push({ server: ev.server, from: ev.from, text });
  }

  public async postStatus(name: string, status: string, reason: string) {
    if (!this.controlChannel) return;
    
    const statusEmoji = status === "ONLINE" ? "🟢" : status === "CONNECTING" ? "🟡" : status === "OFFLINE" ? "🔴" : "⚫";
    const statusColor = status === "ONLINE" ? 0x2ecc71 : status === "CONNECTING" ? 0xf39c12 : 0xe74c3c;
    const compactReason = String(reason || "-")
      .replace(/^connecting\s+/i, "")
      .replace(/^online$/i, "ready")
      .replace(/^reconnecting$/i, "reconnect")
      .replace(/^backoff\s+/i, "backoff ")
      .trim();
    
    const embed = new EmbedBuilder()
      .setColor(statusColor)
      .setTitle(`${statusEmoji} ${name} • ${status} • ${compactReason}`);
    
    try {
      await this.controlChannel.send({ embeds: [embed] });
    } catch (e) {
      this.logger.sys(`[DISCORD] Failed to post status: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async sendHelp(ch: TextChannel) {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`⚔️ ${APP_NAME} v${APP_VERSION}`)
      .setDescription("Ultimate alt control panel")
      .addFields([
        { name: "**Status Indicators**", value: "🟢 Online | 🟡 Connecting | 🔴 Offline | ⚫ Disabled" },
        { name: "🩺 `.alts health`", value: "Live sessions + watcher states" },
        { name: "🔐 `.alts perms`", value: "Show role capabilities and OP scope" },
        { name: "📚 `.alts examples`", value: "Show practical command examples" },
        { name: "📋 `.alts list`", value: "Show all alts and status" },
        { name: "🔍 `.alts status <all|name|slot#>`", value: "Check all or specific alt status" },
        { name: "💬 `.alts say <ign> <message>`", value: "Send normal Minecraft chat + capture response" },
        { name: "⚡ `.alts cmd <ign> <command>`", value: "Run MC command + capture response (supports `tpyes`, `fhome`, `ftop`, `fshow`, etc.)" },
        { name: "🚀 Quick Factions", value: "`.alts tpyes [ign]`, `.alts fhome [ign]`, `.alts ftop [ign]`, `.alts fshow [ign]`, `.alts spawn [ign]`, `.alts home [ign]`, `.alts bal [ign]`" },
        { name: "📣 `.annoucements <message>`", value: "Post @everyone embed to announcements channel" },
        { name: "✉️ `.dmall <message>`", value: "DM all guild users with an embed message" },
        { name: "🧹 `.purge [count]`", value: "Discord-only: delete recent control-channel messages" },
        { name: "♻️ `.restart`", value: "Grand Master only: restart full bot process" },
        { name: "👁️ `.alts watch <status|chat|all> <on|off>`", value: "Fine-grained event watching" },
        { name: "✅ `.alts enable <ign>`", value: "Enable one/all alts (OP-only)" },
        { name: "⛔ `.alts disable <ign>`", value: "Disable one/all alts (OP-only)" },
        { name: "▶️ `.alts start <ign>`", value: "Start alt(s) - can use `all`, `A`, `B`, ign, or slot#" },
        { name: "⏹️ `.alts stop <ign>`", value: "Stop alt(s)" },
        { name: "🔄 `.alts restart <ign>`", value: "Restart alt(s)" },
        { name: "🎯 `.alts move <ign> <A|B>`", value: "Switch alt to server A or B" },
        { name: "⚖️ `.alts balance`", value: "Auto-balance alts between servers" },
        { name: "🔗 `.alts hold/resume/kill`", value: "hold = pause reconnects | resume = continue reconnects | kill = disconnect all + block reconnects" }
      ])
      .setFooter({ text: "Prefix commands only (NO slash commands)" });
    
    try {
      await ch.send({ embeds: [embed] });
    } catch (e) {
      this.logger.sys(`[DISCORD] Failed to send help: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async sendList(ch: TextChannel) {
    const lines = this.pool.listSlotsLines();
    const chunks = chunkLines(lines, 2000);
    
    for (const chunk of chunks) {
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("📋 Alt Pool Routing + Status")
        .setDescription(`\`\`\`\n${chunk}\`\`\``);
      
      try {
        await ch.send({ embeds: [embed] });
      } catch (e) {
        this.logger.sys(`[DISCORD] Failed to post list: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async reply(ch: TextChannel, text: string) {
    try {
      const trimmed = text.length > 3900 ? text.substring(0, 3897) + "..." : text;
      const lowered = trimmed.toLowerCase();
      const isWarn = lowered.startsWith("usage:") || lowered.includes("not found") || lowered.startsWith("unknown") || lowered.startsWith("failed");
      const isOk = lowered.startsWith("ok:") || lowered.startsWith("enabled") || lowered.startsWith("disabled") || lowered.startsWith("sent") || lowered.startsWith("moved") || lowered.startsWith("balance") || lowered.startsWith("watch updated") || lowered.startsWith("purged");
      const color = isWarn ? 0xFEE75C : isOk ? 0x57F287 : 0x5865F2;
      const title = isWarn ? "⚠️ Alt Control" : isOk ? "✅ Alt Control" : "ℹ️ Alt Control";

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(trimmed);

      await ch.send({ embeds: [embed] });
    } catch (e) {
      this.logger.sys(`[DISCORD] Failed to send reply: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async sendChatActionResult(ch: TextChannel, title: string, ign: string, payload: string, names: string[]) {
    try {
      const header = `IGN: ${ign} • Sent: ${names.length}`;
      const preview = names.slice(0, 8).map(n => `• ${n} » ${payload}`);
      if (names.length > 8) preview.push(`• +${names.length - 8} more`);
      const body = [header, ...preview].join("\n");
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(`✅ ${title}`)
        .setDescription(`\`\`\`\n${body}\n\`\`\``);
      await ch.send({ embeds: [embed] });
    } catch (e) {
      this.logger.sys(`[DISCORD] Failed to send chat action result: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private startActionCapture(
    ch: TextChannel,
    title: string,
    ign: string,
    payload: string,
    servers: ServerKey[],
    maxLines: number,
    seedLines: string[] = []
  ) {
    if (!servers.length) return;
    const key = `${Date.now()}|${Math.random().toString(16).slice(2)}`;
    const capture = {
      channel: ch,
      title,
      ign,
      payload,
      servers: new Set(servers),
      maxLines: Math.max(5, Math.min(60, maxLines)),
      lines: [...seedLines] as string[],
      timeout: setTimeout(async () => {
        const found = this.pendingActionCaptures.get(key);
        if (!found) return;
        this.pendingActionCaptures.delete(key);
        await this.flushActionCapture(found);
      }, 9000)
    };
    this.pendingActionCaptures.set(key, capture);
    if (capture.lines.length >= capture.maxLines) {
      clearTimeout(capture.timeout);
      this.pendingActionCaptures.delete(key);
      void this.flushActionCapture(capture);
    }
  }

  private async flushActionCapture(capture: { channel: TextChannel; title: string; ign: string; payload: string; servers: Set<ServerKey>; maxLines: number; lines: string[]; timeout: NodeJS.Timeout; }) {
    try {
      if (!capture.lines.length) {
        return void this.reply(capture.channel, `No Minecraft response captured for \`${capture.payload}\` yet.`);
      }
      const chunks = chunkLines(capture.lines, 1800);
      for (const chunk of chunks) {
        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle(`📥 ${capture.title}`)
          .setDescription(`IGN: ${capture.ign}\n\n\`\`\`\n${chunk}\n\`\`\``);
        await capture.channel.send({ embeds: [embed] });
      }
    } catch (e) {
      this.logger.sys(`[DISCORD] Failed to flush action capture: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleAnnouncement(ch: TextChannel, msg: any, text: string) {
    const target = await this.client.channels.fetch(DISCORD_ANNOUNCEMENTS_CHANNEL_ID).catch(() => null);
    if (!target || !target.isTextBased()) {
      return void this.reply(ch, "Announcements channel not found or not text-based.");
    }

    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle("📢 Official Announcement")
      .setDescription(text.length > 3500 ? text.slice(0, 3500) + "..." : text)
      .setFooter({ text: `By ${msg.author?.tag ?? "Grand Master"}` })
      .setTimestamp();

    try {
      await (target as TextChannel).send({ content: "@everyone", embeds: [embed], allowedMentions: { parse: ["everyone"] } });
      await this.reply(ch, "Announcement posted to <#1451305810348085546> with @everyone.");
      this.logger.sys("[DISCORD] announcement broadcast posted");
    } catch (e) {
      this.logger.sys(`[DISCORD] announcement failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.reply(ch, "Failed to post announcement.");
    }
  }

  private async handleDmall(ch: TextChannel, msg: any, text: string) {
    if (!msg.guild) return void this.reply(ch, "This command must be used in a server.");

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle("📨 Grand Master Message")
      .setDescription(text.length > 3500 ? text.slice(0, 3500) + "..." : text)
      .setFooter({ text: `From ${msg.author?.tag ?? "Grand Master"}` })
      .setTimestamp();

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    try {
      const members = await msg.guild.members.fetch();
      for (const [, member] of members) {
        if (!member || member.user?.bot) {
          skipped++;
          continue;
        }
        try {
          await member.send({ embeds: [embed] });
          sent++;
        } catch {
          failed++;
        }
        await sleep(300);
      }
      await this.reply(ch, `DMall complete: sent=${sent}, failed=${failed}, skipped=${skipped}.`);
      this.logger.sys(`[DISCORD] dmall complete sent=${sent} failed=${failed} skipped=${skipped}`);
    } catch (e) {
      this.logger.sys(`[DISCORD] dmall failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.reply(ch, "DMall failed. Check bot intents/permissions (Guild Members intent may be required).");
    }
  }
}
