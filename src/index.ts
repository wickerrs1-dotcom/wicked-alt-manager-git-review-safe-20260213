import { Logger } from "./util/logger";
import { PoolManager } from "./core/PoolManager";
import { DiscordControl } from "./discord/DiscordControl";
import { APP_NAME, APP_VERSION, TESTING_MODE, TESTING_AUTO_START } from "./constants";
import { sleep } from "./util/rand";
import { loadDotEnv } from './util/env';
import fs from "fs";
import path from "path";
import { SelfTestRunner } from "./testing/SelfTestRunner";

const LOCK_PATH = path.join("state", "runtime.lock");

function acquireSingleInstanceLock(): boolean {
  try {
    fs.mkdirSync("state", { recursive: true });
    if (fs.existsSync(LOCK_PATH)) {
      try {
        const pidText = fs.readFileSync(LOCK_PATH, "utf8").trim();
        const pid = Number.parseInt(pidText, 10);
        if (Number.isFinite(pid) && pid > 0) {
          process.kill(pid, 0);
          return false;
        }
      } catch {
        // stale lock or unreadable pid, remove and continue
      }
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        return false;
      }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid), "utf8");
    return true;
  } catch {
    return false;
  }
}

function releaseSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch {
    // ignore
  }
}

async function main() {
  loadDotEnv();

  if (!acquireSingleInstanceLock()) {
    console.error("Another bot instance is already running. Exiting to prevent duplicate Discord actions.");
    return;
  }

  process.on("exit", releaseSingleInstanceLock);
  process.on("SIGINT", () => { releaseSingleInstanceLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseSingleInstanceLock(); process.exit(0); });
  process.on("uncaughtException", (err) => {
    console.error("Fatal uncaught exception:", err);
    releaseSingleInstanceLock();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Fatal unhandled rejection:", reason);
    releaseSingleInstanceLock();
    process.exit(1);
  });

  const logger = new Logger();
  
  // Intercept console output to suppress startup noise (deprecation + MSA prompt spam)
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  let isStartupPhase = true;
  
  console.warn = (...args: any[]) => {
    const msg = args.join(" ");
    // Only suppress deprecation warnings and MSA auth prompts
    if (isStartupPhase && (msg.includes("DeprecationWarning") || msg.includes("[msa]") && msg.includes("authenticate"))) return;
    originalWarn(...args);
  };
  
  console.error = (...args: any[]) => {
    const msg = args.join(" ");
    // Suppress MSA auth library errors during startup, but keep real errors
    if (isStartupPhase && msg.includes("[msa]")) return;
    originalError(...args);
  };

  console.log = (...args: any[]) => {
    originalLog(...args);
  };

  logger.sys(`${APP_NAME} v${APP_VERSION} starting...`);
  logger.sys("Initializing pool and Discord connection...");

  const pool = new PoolManager(logger);
  pool.initSlots();

  const discord = new DiscordControl(pool, logger);
  pool.setChatCallback((ev) => { void discord.postChat(ev); });
  await discord.start();

  if (TESTING_MODE) {
    logger.sys("[SELFTEST] TESTING_MODE enabled.");
    const selfTestRunner = new SelfTestRunner(pool, discord, logger);
    if (TESTING_AUTO_START) {
      await selfTestRunner.start();
      logger.sys("[SELFTEST] Auto-started test runner.");
    } else {
      logger.sys("[SELFTEST] Auto-start disabled. Set TESTING_AUTO_START=true to begin unattended test run.");
    }
  }

  logger.sys("Connecting alts...");
  
  // Auto-connect all enabled alts immediately
  await pool.startAll();
  
  // Startup phase complete - restore console output
  isStartupPhase = false;
  console.warn = originalWarn;
  console.error = originalError;
  console.log = originalLog;
  
  logger.sys("✓ All systems ready. Running main loop.");
  logger.sys("Discord status watch is ON by default. Use .alts watch off to disable");

  // Main loop tick
  while (true) {
    await pool.tick();
    await sleep(1000);
  }
}

void main();