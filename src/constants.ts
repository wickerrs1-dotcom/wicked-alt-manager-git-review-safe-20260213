import fs from "fs";
import path from "path";

// Load configuration from config.json
let config: any = {};
try {
  const configPath = path.join(process.cwd(), "config.json");
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
} catch (e) {
  console.error("Failed to load config.json:", e);
}

export const APP_NAME = "Wicked Alt Manager";
export const APP_VERSION = "2.0.1";

export const MC_VERSION = "1.8.9"; // Fixed for 1.8.9 servers

// Servers - customize in config.json
export const SERVERS = {
  A: { 
    key: "A" as const, 
    host: config.servers?.A?.host || "example-a.server.invalid", 
    port: config.servers?.A?.port || 25565, 
    joinCommand: config.servers?.A?.joinCommand || "/server factions" 
  },
  B: { 
    key: "B" as const, 
    host: config.servers?.B?.host || "example-b.server.invalid", 
    port: config.servers?.B?.port || 25565, 
    joinCommand: config.servers?.B?.joinCommand || "/factions" 
  }
};

export const SERVER_A_ENABLED = config.servers?.A?.enabled !== false;
export const SERVER_B_ENABLED = config.servers?.B?.enabled !== false;

// Discord control
export const DISCORD_PREFIX = ".alts";
export const DISCORD_CONTROL_ROLE_ID = "1451305809169354799";
export const DISCORD_CONTROL_CHANNEL_ID = "1451305811392594022";
export const DISCORD_GRANDMASTER_USER_ID = "798280002004582410";
export const DISCORD_ANNOUNCEMENTS_CHANNEL_ID = "1451305810348085546";

// Anti-spam / safety - customize in config.json
export const CONNECT_SPACING_MS = config.timing?.connectSpacingMs || 8000;
export const SEND_MIN_INTERVAL_MS = 1000; // Per-alt chat limit (not in config - keep at 1s)
export const HUB_JOIN_DELAY_MIN_MS = config.timing?.hubJoinDelayMinMs || 6000;
export const HUB_JOIN_DELAY_MAX_MS = config.timing?.hubJoinDelayMaxMs || 10000;

// Reconnect policies - customize in config.json
export const BACKOFF_SOCKET_MIN_MS = config.reconnect?.socketBackoffMinMs || 2 * 60_000;
export const BACKOFF_SOCKET_MAX_MS = config.reconnect?.socketBackoffMaxMs || 5 * 60_000;

export const BACKOFF_KICK_MIN_MS = config.reconnect?.kickBackoffMinMs || 10 * 60_000;
export const BACKOFF_KICK_MAX_MS = config.reconnect?.kickBackoffMaxMs || 20 * 60_000;

export const BACKOFF_AUTH_MIN_MS = config.reconnect?.authBackoffMinMs || 15 * 60_000;
export const BACKOFF_AUTH_MAX_MS = config.reconnect?.authBackoffMaxMs || 25 * 60_000;

export const CONNECT_TIMEOUT_MS = config.timing?.connectTimeoutMs || 45_000; // stuck-connecting watchdog

export const MAX_SLOTS = 20; // Max alts per pool - edit accounts.json to enable/disable specific alts

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const testingConfig = config.testing ?? {};

export const TESTING_MODE = asBool(process.env.TESTING_MODE ?? testingConfig.enabled, false);
export const TESTING_AUTO_START = asBool(process.env.TESTING_AUTO_START ?? testingConfig.autoStart, false);
export const TESTING_DURATION_HOURS = asNumber(process.env.TESTING_DURATION_HOURS ?? testingConfig.durationHours, 12);
export const TESTING_COMMAND_INTERVAL_MS = asNumber(process.env.TESTING_COMMAND_INTERVAL_MS ?? testingConfig.commandIntervalMs, 90_000);
export const TESTING_PHASE_ONE_ALTS = asNumber(process.env.TESTING_PHASE_ONE_ALTS ?? testingConfig.phaseOneAlts, 2);
export const TESTING_PHASE_TWO_ALTS = asNumber(process.env.TESTING_PHASE_TWO_ALTS ?? testingConfig.phaseTwoAlts, 13);
export const TESTING_PHASE_ONE_HOURS = asNumber(process.env.TESTING_PHASE_ONE_HOURS ?? testingConfig.phaseOneHours, 2);
export const TESTING_INCLUDE_DISRUPTIVE = asBool(process.env.TESTING_INCLUDE_DISRUPTIVE ?? testingConfig.includeDisruptiveCommands, false);
