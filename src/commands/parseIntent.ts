import type { IncomingGroupMessage } from "../whatsapp/client.js";
import { getPendingOrders } from "../ledger/queries.js";

export type Intent =
  | { type: "confirm"; whatsappMsgId: string }
  | { type: "balance" }
  | { type: "schedule_create"; text: string }
  | { type: "schedule_cancel" }
  | { type: "order"; text: string }
  | { type: "ignore" };

const YES_RE = /\byes\b|👍/i;
const BALANCE_RE = /\b(balance|who\s+owes|owes\s+who)\b/i;
const SCHEDULE_CANCEL_RE = /\bcancel\b.*\bschedule\b|\bstop\b.*\b(lunch|order)\b/i;
const SCHEDULE_CREATE_RE =
  /\bevery\s+(weekday|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/** Classifies one incoming group text message into an action for index.ts to take. */
export function parseIntent(msg: IncomingGroupMessage): Intent {
  const text = msg.text.trim();

  if (msg.quotedMessageId) {
    const pending = getPendingOrders().find(
      (o) => o.whatsapp_msg_id === msg.quotedMessageId,
    );
    if (pending && YES_RE.test(text)) {
      return { type: "confirm", whatsappMsgId: pending.whatsapp_msg_id };
    }
  }

  if (YES_RE.test(text) && text.length < 20) {
    // A short bare "yes" with no quote: confirm the single most recent pending
    // cart, if there is exactly one - ambiguous otherwise, so ignore rather than
    // guess which of several pending orders was meant.
    const pending = getPendingOrders();
    if (pending.length === 1) {
      return { type: "confirm", whatsappMsgId: pending[0].whatsapp_msg_id };
    }
  }

  if (SCHEDULE_CANCEL_RE.test(text)) {
    return { type: "schedule_cancel" };
  }

  if (SCHEDULE_CREATE_RE.test(text) && /\b(order|get)\b/i.test(text)) {
    return { type: "schedule_create", text };
  }

  if (BALANCE_RE.test(text)) {
    return { type: "balance" };
  }

  if (/\b(order|get)\b/i.test(text)) {
    return { type: "order", text };
  }

  return { type: "ignore" };
}
