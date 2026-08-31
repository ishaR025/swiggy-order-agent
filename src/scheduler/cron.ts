import cron, { type ScheduledTask } from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../ledger/db.js";
import { sendMessage } from "../whatsapp/client.js";
import { sendScheduleNudge, SCHEDULE_NUDGE_TEMPLATE_NAME } from "../whatsapp/templates.js";
import {
  insertScheduleNudge,
  getAwaitingNudges,
  markNudgeExpired,
  type ScheduleNudgeRow,
} from "../ledger/queries.js";

const NUDGE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
const nudgeExpiryTimers = new Map<number, NodeJS.Timeout>();

function scheduleNudgeExpiry(nudge: Pick<ScheduleNudgeRow, "id" | "intent_text">, delayMs: number) {
  const timer = setTimeout(() => {
    nudgeExpiryTimers.delete(nudge.id);
    markNudgeExpired(nudge.id);
  }, Math.max(delayMs, 0));
  nudgeExpiryTimers.set(nudge.id, timer);
}

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const ScheduleSchema = z.object({
  cron: z
    .string()
    .describe("Standard 5-field cron expression, e.g. '0 13 * * 1-5' for weekdays at 1pm"),
  intentText: z
    .string()
    .describe('What to order each time, e.g. "lunch from usual place"'),
});

async function parseScheduleRequest(
  text: string,
): Promise<{ cron: string; intentText: string }> {
  const response = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 1000,
    system:
      "Convert a recurring order request into a 5-field cron expression (minute hour day month weekday) " +
      "in the server's local timezone, plus the recurring intent text to re-resolve fresh at each firing. " +
      'Example: "order lunch every weekday at 1pm" -> {"cron": "0 13 * * 1-5", "intentText": "lunch from usual place"}',
    output_config: { format: zodOutputFormat(ScheduleSchema) },
    messages: [{ role: "user", content: text }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No structured output returned from schedule parser");
  }
  return ScheduleSchema.parse(JSON.parse(textBlock.text));
}

type ActiveSchedule = { id: number; task: ScheduledTask };
const active = new Map<number, ActiveSchedule>();

function register(id: number, createdByJid: string, cronExpr: string, intentText: string) {
  const task = cron.schedule(cronExpr, async () => {
    // Fires outside any 24h "user just messaged" window, so it can only send the
    // pre-approved nudge template, not the free-form cart itself. Whatever the
    // person replies with next reopens the window and triggers the real
    // resolve+cart flow - see index.ts's nudge-reply check ahead of parseIntent().
    try {
      const msgId = await sendScheduleNudge(createdByJid, intentText);
      const nudgeId = insertScheduleNudge({
        scheduleId: id,
        createdByJid,
        intentText,
        whatsappMsgId: msgId,
      });
      scheduleNudgeExpiry({ id: nudgeId, intent_text: intentText }, NUDGE_TIMEOUT_MS);
    } catch (err) {
      console.error(`Scheduled nudge for "${intentText}" failed:`, err);
    }
  });
  active.set(id, { id, task });
}

export async function createSchedule(createdByJid: string, requestText: string): Promise<void> {
  const { cron: cronExpr, intentText } = await parseScheduleRequest(requestText);

  if (!cron.validate(cronExpr)) {
    await sendMessage(
      createdByJid,
      `Couldn't turn "${requestText}" into a valid schedule (got cron "${cronExpr}"). Try rephrasing.`,
    );
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO schedules (created_by_jid, cron_expression, intent_text) VALUES (?, ?, ?)`,
    )
    .run(createdByJid, cronExpr, intentText);

  register(Number(result.lastInsertRowid), createdByJid, cronExpr, intentText);

  await sendMessage(
    createdByJid,
    `📅 Scheduled: "${intentText}" (cron: ${cronExpr}). Each time, I'll nudge you here, and once you reply I'll show today's cart for a 👍/"yes" before ordering - never automatically. ` +
      `(Requires the "${SCHEDULE_NUDGE_TEMPLATE_NAME}" WhatsApp template to be approved - run \`npm run setup-whatsapp-template\` once if you haven't.)`,
  );
}

export async function cancelSchedules(createdByJid: string): Promise<void> {
  const rows = db
    .prepare(`SELECT id, intent_text FROM schedules WHERE active = 1 AND created_by_jid = ?`)
    .all(createdByJid) as { id: number; intent_text: string }[];

  if (rows.length === 0) {
    await sendMessage(createdByJid, "No active schedules to cancel.");
    return;
  }

  for (const row of rows) {
    active.get(row.id)?.task.stop();
    active.delete(row.id);
    db.prepare(`UPDATE schedules SET active = 0 WHERE id = ?`).run(row.id);
  }

  await sendMessage(createdByJid, `Cancelled: ${rows.map((r) => `"${r.intent_text}"`).join(", ")}.`);
}

/** Re-registers every active schedule from the DB - call once on process boot. */
export function rehydrateSchedules(): void {
  const rows = db
    .prepare(`SELECT id, created_by_jid, cron_expression, intent_text FROM schedules WHERE active = 1`)
    .all() as { id: number; created_by_jid: string; cron_expression: string; intent_text: string }[];

  for (const row of rows) {
    register(row.id, row.created_by_jid, row.cron_expression, row.intent_text);
    console.log(`Rehydrated schedule #${row.id}: "${row.intent_text}" (${row.cron_expression})`);
  }
}

/** Call when a nudge is resolved (its reply arrived) to cancel its pending auto-expiry. */
export function clearNudgeExpiry(nudgeId: number): void {
  const timer = nudgeExpiryTimers.get(nudgeId);
  if (timer) {
    clearTimeout(timer);
    nudgeExpiryTimers.delete(nudgeId);
  }
}

/** Re-registers in-memory expiry timers for any nudges still awaiting a reply
 * after a restart - call once on process boot alongside rehydrateSchedules(). */
export function rehydrateNudges(): void {
  for (const nudge of getAwaitingNudges()) {
    const elapsed = Date.now() - new Date(nudge.created_at + "Z").getTime();
    const remaining = NUDGE_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      markNudgeExpired(nudge.id);
      continue;
    }
    scheduleNudgeExpiry(nudge, remaining);
  }
}
