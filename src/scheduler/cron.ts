import cron, { type ScheduledTask } from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../ledger/db.js";
import { sendMessage } from "../whatsapp/client.js";
import { requestOrder } from "../orders/pendingOrders.js";

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
  const task = cron.schedule(cronExpr, () => {
    // NOTE: this fires outside any 24h "user just messaged" window, so on the
    // real Cloud API this free-form sendMessage() call will be rejected unless
    // createdByJid happened to message the bot recently. Once a WhatsApp
    // message template is created and approved in the Meta dashboard, swap
    // this for sendTemplateMessage() - see src/whatsapp/client.ts.
    requestOrder(createdByJid, intentText).catch((err) =>
      console.error(`Scheduled order (${intentText}) failed:`, err),
    );
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
    `📅 Scheduled: "${intentText}" (cron: ${cronExpr}). Each time, I'll message you here for a 👍/"yes" before ordering - never automatically. ` +
      `Note: until a WhatsApp message template is approved for this, the daily nudge only works if you've messaged me within the last 24h.`,
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
