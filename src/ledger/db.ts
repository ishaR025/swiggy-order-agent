import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp_msg_id TEXT NOT NULL UNIQUE,
    requester_jid TEXT NOT NULL,
    requester_name TEXT,
    request_text TEXT NOT NULL,
    service TEXT NOT NULL,                 -- 'food' | 'instamart'
    restaurant_or_store TEXT,
    items_json TEXT NOT NULL,
    total_amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    place_order_tool TEXT NOT NULL,
    place_order_args_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_confirmation',
                                            -- pending_confirmation | placed | failed | expired
    swiggy_order_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by_jid TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    intent_text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A scheduled trigger fires outside any guaranteed 24h WhatsApp active window, so it
  -- can only send a pre-approved template nudge, not the free-form cart itself. This
  -- tracks that nudge until the person replies (any reply reopens the window - see
  -- requestOrder() in orders/pendingOrders.ts) or it expires unanswered.
  CREATE TABLE IF NOT EXISTS schedule_nudges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    created_by_jid TEXT NOT NULL,
    intent_text TEXT NOT NULL,
    whatsapp_msg_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_reply',  -- awaiting_reply | resolved | expired
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- food and instamart are independently-protected OAuth resources on mcp.swiggy.com
  -- (confirmed empirically: authenticating one does not authenticate the other), so each
  -- gets its own row/token rather than sharing a single stored credential.
  CREATE TABLE IF NOT EXISTS swiggy_token (
    service TEXT PRIMARY KEY CHECK (service IN ('food', 'instamart')),
    access_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
