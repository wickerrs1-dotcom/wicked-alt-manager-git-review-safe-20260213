import fs from "fs";
import path from "path";
import { PoolManager } from "../core/PoolManager";
import { DiscordControl } from "../discord/DiscordControl";
import { Logger } from "../util/logger";
import { sleep } from "../util/rand";
import {
  CONNECT_SPACING_MS,
  TESTING_COMMAND_INTERVAL_MS,
  TESTING_DURATION_HOURS,
  TESTING_INCLUDE_DISRUPTIVE,
  TESTING_PHASE_ONE_ALTS,
  TESTING_PHASE_ONE_HOURS,
  TESTING_PHASE_TWO_ALTS
} from "../constants";

type Phase = {
  name: string;
  targetAlts: number;
  durationMs: number;
};

type StepResult = {
  at: string;
  phase: string;
  command: string;
  ok: boolean;
  note?: string;
};

export class SelfTestRunner {
  private running = false;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private phaseStartedAt = 0;
  private phaseIndex = 0;
  private commandIndex = 0;
  private moveFlip: "A" | "B" = "A";

  private readonly phases: Phase[] = [];
  private readonly steps: StepResult[] = [];

  private statusPath: string;
  private reportPath: string;

  constructor(
    private readonly pool: PoolManager,
    private readonly discord: DiscordControl,
    private readonly logger: Logger,
    logsDir = "logs"
  ) {
    this.statusPath = path.join(logsDir, "selftest-status.json");
    this.reportPath = path.join(logsDir, "selftest-report.json");

    const totalMs = Math.max(1, TESTING_DURATION_HOURS) * 60 * 60 * 1000;
    const p1Ms = Math.min(totalMs, Math.max(1, TESTING_PHASE_ONE_HOURS) * 60 * 60 * 1000);
    const p2Ms = Math.max(0, totalMs - p1Ms);

    this.phases.push({ name: "phase-1-2alts", targetAlts: Math.max(1, TESTING_PHASE_ONE_ALTS), durationMs: p1Ms });
    if (p2Ms > 0) {
      this.phases.push({ name: "phase-2-load", targetAlts: Math.max(TESTING_PHASE_ONE_ALTS, TESTING_PHASE_TWO_ALTS), durationMs: p2Ms });
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.startedAt = Date.now();
    this.phaseStartedAt = Date.now();
    this.phaseIndex = 0;
    this.commandIndex = 0;
    this.steps.length = 0;

    this.logger.sys(`[SELFTEST] Starting automated soak for ${TESTING_DURATION_HOURS}h (${this.phases.map(p => `${p.name}:${p.targetAlts}`).join(", ")})`);

    await this.applyPhase();
    await this.writeStatus();

    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(20_000, TESTING_COMMAND_INTERVAL_MS));
  }

  public async stop(reason = "manual stop"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const report = {
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      reason,
      phases: this.phases,
      steps: this.steps,
      summary: this.snapshot()
    };

    fs.writeFileSync(this.reportPath, JSON.stringify(report, null, 2), "utf8");
    this.logger.sys(`[SELFTEST] Stopped (${reason}). Report: ${this.reportPath}`);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      if (!this.discord.isReady()) {
        this.pushStep({ ok: false, command: "(wait-discord)", note: "Discord control channel not ready yet" });
        await this.writeStatus();
        return;
      }

      const phase = this.phases[this.phaseIndex];
      const elapsedInPhase = Date.now() - this.phaseStartedAt;
      if (elapsedInPhase >= phase.durationMs) {
        this.phaseIndex++;
        if (this.phaseIndex >= this.phases.length) {
          await this.stop("completed all phases");
          return;
        }
        this.phaseStartedAt = Date.now();
        this.commandIndex = 0;
        await this.applyPhase();
      }

      const command = this.nextCommand();
      const ok = await this.discord.runInternalCommandAsGM(command);
      this.pushStep({ ok, command, note: ok ? undefined : "discord not ready" });

      await this.writeStatus();
    } catch (e) {
      this.pushStep({ ok: false, command: "(tick-error)", note: e instanceof Error ? e.message : String(e) });
      await this.writeStatus();
    } finally {
      this.inFlight = false;
    }
  }

  private async applyPhase(): Promise<void> {
    const phase = this.phases[this.phaseIndex];
    const sessions = [...this.pool.sessions].sort((a, b) => a.slotNumber - b.slotNumber);
    const target = Math.min(phase.targetAlts, sessions.length);

    this.logger.sys(`[SELFTEST] Applying ${phase.name}: target active alts=${target}/${sessions.length}`);

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const shouldBeActive = i < target;
      if (shouldBeActive) {
        if (!session.enabled) {
          session.start();
        }
        await session.connect();
        await sleep(CONNECT_SPACING_MS);
      } else {
        if (session.enabled) {
          session.stop("selftest phase inactive");
        }
      }
      this.pool.persist();
    }
  }

  private nextCommand(): string {
    const base = [
      ".alts health",
      ".alts status all",
      ".alts list",
      ".alts say all hi",
      ".alts cmd all f top"
    ];

    const advanced = [
      ".alts watch status on",
      ".alts watch chat on",
      ".alts move all A",
      ".alts move all B",
      ".alts balance",
      ".purge 1"
    ];

    const phase = this.phases[this.phaseIndex]?.name ?? "phase";
    const pool = phase.includes("load") ? [...base, ...advanced] : base;

    let cmd = pool[this.commandIndex % pool.length];
    this.commandIndex++;

    if (cmd === ".alts move all A" || cmd === ".alts move all B") {
      cmd = `.alts move all ${this.moveFlip}`;
      this.moveFlip = this.moveFlip === "A" ? "B" : "A";
    }

    if (!TESTING_INCLUDE_DISRUPTIVE && (cmd.startsWith(".alts move") || cmd === ".alts balance" || cmd.startsWith(".purge"))) {
      cmd = ".alts health";
    }

    return cmd;
  }

  private snapshot() {
    const total = this.pool.sessions.length;
    const enabled = this.pool.sessions.filter((s) => s.enabled).length;
    const online = this.pool.sessions.filter((s) => s.status === "ONLINE").length;
    const connecting = this.pool.sessions.filter((s) => s.status === "CONNECTING" || s.status === "RECONNECTING").length;
    const backoff = this.pool.sessions.filter((s) => s.status === "BACKOFF").length;
    const totalDisconnects = this.pool.sessions.reduce((n, s) => n + s.disconnectCount, 0);
    const totalKicks = this.pool.sessions.reduce((n, s) => n + s.kickCount, 0);
    const totalErrors = this.pool.sessions.reduce((n, s) => n + s.errorCount, 0);

    const passed = this.steps.filter((s) => s.ok).length;
    const failed = this.steps.filter((s) => !s.ok).length;

    return {
      running: this.running,
      total,
      enabled,
      online,
      connecting,
      backoff,
      totalDisconnects,
      totalKicks,
      totalErrors,
      stepPassed: passed,
      stepFailed: failed,
      phase: this.phases[this.phaseIndex]?.name ?? "done"
    };
  }

  private pushStep(input: { ok: boolean; command: string; note?: string }) {
    const step: StepResult = {
      at: new Date().toISOString(),
      phase: this.phases[this.phaseIndex]?.name ?? "done",
      command: input.command,
      ok: input.ok,
      note: input.note
    };
    this.steps.push(step);
    if (this.steps.length > 1000) this.steps.splice(0, this.steps.length - 1000);
    this.logger.sys(`[SELFTEST] ${step.ok ? "OK" : "FAIL"} ${step.phase} :: ${step.command}${step.note ? ` (${step.note})` : ""}`);
  }

  private async writeStatus(): Promise<void> {
    const status = {
      startedAt: new Date(this.startedAt).toISOString(),
      now: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      commandIntervalMs: TESTING_COMMAND_INTERVAL_MS,
      summary: this.snapshot(),
      lastSteps: this.steps.slice(-30)
    };
    fs.writeFileSync(this.statusPath, JSON.stringify(status, null, 2), "utf8");
  }
}
