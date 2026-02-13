import fs from "fs";
import path from "path";

// ANSI color codes for clean console output
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
};

function redact(s: string): string {
  // simple redaction for token-ish strings
  return s.replace(/([A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})/g, "[REDACTED_TOKEN]");
}

function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export class Logger {
  private systemPath: string;
  
  constructor(private logsDir = "logs") {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    this.systemPath = path.join(logsDir, "system.log");
  }

  sys(line: string) {
    const clean = redact(line);
    const timestamp = new Date().toISOString();
    const out = `${timestamp} ${clean}\n`;
    fs.appendFileSync(this.systemPath, out, "utf8");
    
    // Color-coded console output
    if (line.includes("[DISCORD]")) {
      console.log(`${colors.magenta}${formatTime()} ${clean}${colors.reset}`);
    } else if (line.includes("[MC]") || line.includes("ONLINE") || line.includes("CONNECTING")) {
      console.log(`${colors.cyan}${formatTime()} ${clean}${colors.reset}`);
    } else if (line.includes("✓") || line.includes("OK")) {
      console.log(`${colors.green}${formatTime()} ${clean}${colors.reset}`);
    } else if (line.includes("[POOL]")) {
      console.log(`${colors.dim}${formatTime()} ${clean}${colors.reset}`);
    } else {
      console.log(`${colors.dim}${formatTime()}${colors.reset} ${clean}`);
    }
  }

  alt(altName: string, line: string) {
    let safeName = altName.replace(/[^a-z0-9\-_.]/gi, "_");
    if (safeName.length > 32) {
      safeName = safeName.substring(0, 32);
    }
    const p = path.join(this.logsDir, `${safeName}.log`);
    const out = `${new Date().toISOString()} ${redact(line)}\n`;
    fs.appendFileSync(p, out, "utf8");
  }
}
