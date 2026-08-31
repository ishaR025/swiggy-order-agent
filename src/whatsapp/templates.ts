import { sendTemplateMessage } from "./client.js";

// Verified against Meta's Template API docs (message_templates create endpoint):
// {name, category, language, components: [{type:"BODY", text, example}]}.
// Kept intentionally generic (one variable: the intent text) rather than trying to
// cram a full dynamic cart into a template - WhatsApp templates are reviewed/approved
// content and can't vary in structure per send. The actual cart is sent as free-form
// text once the person's reply reopens the 24h window - see requestOrder().
export const SCHEDULE_NUDGE_TEMPLATE_NAME = "scheduled_order_nudge";
export const SCHEDULE_NUDGE_TEMPLATE_LANGUAGE = "en";
export const SCHEDULE_NUDGE_TEMPLATE_BODY =
  "⏰ Time for your scheduled order: {{1}}. Reply to this message (anything, even just \"ok\") to see today's cart and confirm - or ignore it to skip today.";

/** Sends the approved scheduled-order nudge template. Fails if the template
 * isn't APPROVED yet - run `npm run setup-whatsapp-template` first and wait
 * for approval (check status with the same script). */
export function sendScheduleNudge(to: string, intentText: string): Promise<string> {
  return sendTemplateMessage(
    to,
    SCHEDULE_NUDGE_TEMPLATE_NAME,
    SCHEDULE_NUDGE_TEMPLATE_LANGUAGE,
    [intentText],
  );
}
