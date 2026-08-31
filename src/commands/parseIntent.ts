import type { IncomingChatMessage } from "../whatsapp/client.js";
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

/**
 * Classifies one incoming DM into an action for index.ts to take. Each person's
 * orders/confirmations are scoped to their own number - pending-order lookups
 * only ever consider orders that same person requested.
 */
export function parseIntent(msg: IncomingChatMessage): Intent {
  const text = msg.text.trim();
  const myPending = getPendingOrders().filter((o) => o.requester_jid === msg.from);

  if (msg.contextMessageId) {
    const pending = myPending.find((o) => o.whatsapp_msg_id === msg.contextMessageId);
    if (pending && YES_RE.test(text)) {
      return { type: "confirm", whatsappMsgId: pending.whatsapp_msg_id };
    }
  }

  if (YES_RE.test(text) && text.length < 20) {
    // A short bare "yes" with no quote: confirm this person's single most
    // recent pending cart, if there is exactly one - ambiguous otherwise, so
    // ignore rather than guess which one was meant.
    if (myPending.length === 1) {
      return { type: "confirm", whatsappMsgId: myPending[0].whatsapp_msg_id };
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
