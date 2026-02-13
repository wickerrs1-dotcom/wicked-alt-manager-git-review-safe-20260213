import fs from "fs";
import { accountIdFromEmail } from "./account";

export type AltStateStore = {
  slots: Array<{
    accountId: string;
    server: "A" | "B";
    enabled: boolean;
    username?: string;
    uuid?: string;
    status?: string;
    reason?: string;
    nextRetryAt?: number;
    lastSeenAt?: number;
  }>;
  holdReconnect: boolean;
  killed: boolean;
};

const STATE_PATH = "state/alts.json";

function normalizeState(raw: any): AltStateStore {
  const safe = raw && typeof raw === "object" ? raw : {};

  const slots = Array.isArray(safe.slots)
    ? safe.slots
        .filter((s: any) => s && typeof s === "object" && (typeof s.accountId === "string" || typeof s.email === "string"))
        .map((s: any) => ({
          accountId: typeof s.accountId === "string" && s.accountId.trim()
            ? s.accountId.trim()
            : accountIdFromEmail(String(s.email)),
          server: s.server === "B" ? "B" : "A",
          enabled: Boolean(s.enabled),
          username: typeof s.username === "string" ? s.username : undefined,
          uuid: typeof s.uuid === "string" ? s.uuid : undefined,
          status: typeof s.status === "string" ? s.status : undefined,
          reason: typeof s.reason === "string" ? s.reason : undefined,
          nextRetryAt: typeof s.nextRetryAt === "number" ? s.nextRetryAt : undefined,
          lastSeenAt: typeof s.lastSeenAt === "number" ? s.lastSeenAt : undefined,
        }))
    : [];

  return {
    slots,
    holdReconnect: Boolean(safe.holdReconnect),
    killed: Boolean(safe.killed),
  };
}

export function loadState(): AltStateStore {
  if (!fs.existsSync(STATE_PATH)) {
    return { slots: [], holdReconnect: false, killed: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return normalizeState(parsed);
  } catch {
    return { slots: [], holdReconnect: false, killed: false };
  }
}

export function saveState(s: AltStateStore) {
  fs.mkdirSync("state", { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf8");
}
