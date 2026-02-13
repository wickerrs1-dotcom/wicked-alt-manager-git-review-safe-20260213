import fs from 'fs';
import path from 'path';

export function loadDotEnv(path = '.env') {
  try {
    if (!fs.existsSync(path)) return;
    const raw = fs.readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of raw) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      const key = t.slice(0, idx).trim();
      const val = t.slice(idx + 1).trim();
      if (!key) continue;
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore
  }

  try {
    if (!process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN_FILE) {
      const tokenPath = process.env.DISCORD_TOKEN_FILE;
      const resolved = pathModuleResolve(tokenPath);
      if (fs.existsSync(resolved)) {
        const secret = fs.readFileSync(resolved, 'utf8').trim();
        if (secret) process.env.DISCORD_TOKEN = secret;
      }
    }
  } catch {
    // ignore
  }
}

function pathModuleResolve(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}
