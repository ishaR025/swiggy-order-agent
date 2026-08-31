import { db } from "../ledger/db.js";

export type SwiggyService = "food" | "instamart";

export type StoredToken = {
  accessToken: string;
  expiresAt: Date;
};

const upsertStmt = db.prepare(`
  INSERT INTO swiggy_token (service, access_token, expires_at, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(service) DO UPDATE SET
    access_token = excluded.access_token,
    expires_at = excluded.expires_at,
    updated_at = datetime('now')
`);

const selectStmt = db.prepare(
  `SELECT access_token, expires_at FROM swiggy_token WHERE service = ?`,
);

export function storeToken(
  service: SwiggyService,
  accessToken: string,
  expiresAt: Date,
): void {
  upsertStmt.run(service, accessToken, expiresAt.toISOString());
}

export function getToken(service: SwiggyService): StoredToken | null {
  const row = selectStmt.get(service) as
    | { access_token: string; expires_at: string }
    | undefined;
  if (!row) return null;
  return { accessToken: row.access_token, expiresAt: new Date(row.expires_at) };
}

const REAUTH_WARNING_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

export type TokenStatus =
  | { state: "missing" }
  | { state: "expired" }
  | { state: "expiring_soon"; hoursLeft: number }
  | { state: "ok" };

export function getTokenStatus(service: SwiggyService): TokenStatus {
  const token = getToken(service);
  if (!token) return { state: "missing" };

  const msLeft = token.expiresAt.getTime() - Date.now();
  if (msLeft <= 0) return { state: "expired" };
  if (msLeft <= REAUTH_WARNING_WINDOW_MS) {
    return { state: "expiring_soon", hoursLeft: Math.round(msLeft / 3_600_000) };
  }
  return { state: "ok" };
}

export function requireAccessToken(service: SwiggyService): string {
  const token = getToken(service);
  if (!token || token.expiresAt.getTime() <= Date.now()) {
    throw new Error(
      `No valid Swiggy ${service} access token. Run \`npm run swiggy-login\` and push the new token before placing orders.`,
    );
  }
  return token.accessToken;
}
