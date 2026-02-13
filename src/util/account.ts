import crypto from "crypto";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function accountIdFromEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex");
  return `acct_${digest.slice(0, 16)}`;
}

export function legacyCacheKeyFromEmail(email: string): string {
  return normalizeEmail(email).replace(/[^a-z0-9]/g, "_");
}
