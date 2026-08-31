import { sendMessage } from "../whatsapp/client.js";
import { resolveOrder, type ResolvedOrder } from "../swiggy/resolveOrder.js";
import { placeOrder } from "../swiggy/placeOrder.js";
import {
  insertPendingOrder,
  markOrderPlaced,
  markOrderFailed,
  markOrderExpired,
  getOrderByMessageId,
  getPendingOrders,
} from "../ledger/queries.js";

const CONFIRMATION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const expiryTimers = new Map<string, NodeJS.Timeout>();

function formatCartMessage(resolved: ResolvedOrder, requestText: string): string {
  const lines = resolved.items.map(
    (item) => `  - ${item.quantity} x ${item.name} (₹${item.price})`,
  );
  const assumptions = resolved.assumptionsMade.length
    ? `\nAssumptions: ${resolved.assumptionsMade.join("; ")}`
    : "";
  return [
    `🛒 Cart for: "${requestText}"`,
    `${resolved.service === "food" ? "Restaurant" : "Store"}: ${resolved.restaurantOrStore}`,
    ...lines,
    `Total: ₹${resolved.total} (${resolved.paymentMethod})`,
    assumptions,
    "",
    `React 👍 or reply "yes" to confirm. Expires in 2 hours.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Runs the full ad-hoc/scheduled order flow: resolve -> post cart to the
 * requester's own DM thread -> track as pending, with a timeout that
 * auto-expires it if nobody confirms. Never calls placeOrder() itself - that
 * only happens from confirmOrder() below, in response to an explicit 👍/"yes"
 * from that same person (each person's orders are independent - see the
 * project's cross-notify decision).
 */
export async function requestOrder(requesterNumber: string, requestText: string): Promise<void> {
  let resolved: ResolvedOrder;
  try {
    resolved = await resolveOrder(requestText);
  } catch (err) {
    await sendMessage(
      requesterNumber,
      `Couldn't resolve "${requestText}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const cartText = formatCartMessage(resolved, requestText);
  const msgId = await sendMessage(requesterNumber, cartText);

  insertPendingOrder({
    whatsappMsgId: msgId,
    requesterJid: requesterNumber,
    requesterName: null,
    requestText,
    resolved,
  });

  const timer = setTimeout(() => {
    expiryTimers.delete(msgId);
    const row = getOrderByMessageId(msgId);
    if (row?.status === "pending_confirmation") {
      markOrderExpired(msgId);
      sendMessage(
        requesterNumber,
        `⌛ Cart for "${requestText}" expired - nobody confirmed in time.`,
      ).catch((err) => console.error("Failed to post expiry notice:", err));
    }
  }, CONFIRMATION_TIMEOUT_MS);
  expiryTimers.set(msgId, timer);
}

/**
 * Called on a 👍 reaction or a "yes" reply targeting a pending cart message.
 * This is the only path that ever calls placeOrder() - a deterministic replay
 * of exactly what was shown and approved, nothing re-decided here.
 */
export async function confirmOrder(whatsappMsgId: string): Promise<void> {
  const row = getOrderByMessageId(whatsappMsgId);
  if (!row || row.status !== "pending_confirmation") return;

  const requesterNumber = row.requester_jid;

  const timer = expiryTimers.get(whatsappMsgId);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(whatsappMsgId);
  }

  const result = await placeOrder({
    service: row.service as ResolvedOrder["service"],
    placeOrderTool: row.place_order_tool as ResolvedOrder["placeOrderTool"],
    placeOrderArgs: JSON.parse(row.place_order_args_json),
  });

  if (result.isError) {
    markOrderFailed(whatsappMsgId);
    await sendMessage(
      requesterNumber,
      `❌ Order failed: ${result.summaryText || "unknown error"}. Check get_food_orders/get_orders before retrying.`,
    );
    return;
  }

  const swiggyOrderId = extractOrderId(result.summaryText) ?? "unknown";
  markOrderPlaced(whatsappMsgId, swiggyOrderId);
  await sendMessage(requesterNumber, `✅ Order placed! ${result.summaryText}`);
}

function extractOrderId(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.orderId === "string") return parsed.orderId;
  } catch {
    // not JSON - fall through to a loose regex match
  }
  const match = text.match(/"?orderId"?\s*[:=]\s*"?(\w[\w-]*)"?/i);
  return match ? match[1] : null;
}

/** Re-registers in-memory expiry timers for any orders still pending after a restart. */
export function rehydratePendingOrders(): void {
  for (const row of getPendingOrders()) {
    const elapsed = Date.now() - new Date(row.created_at + "Z").getTime();
    const remaining = CONFIRMATION_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      markOrderExpired(row.whatsapp_msg_id);
      continue;
    }
    const timer = setTimeout(() => {
      expiryTimers.delete(row.whatsapp_msg_id);
      const current = getOrderByMessageId(row.whatsapp_msg_id);
      if (current?.status === "pending_confirmation") {
        markOrderExpired(row.whatsapp_msg_id);
        sendMessage(
          row.requester_jid,
          `⌛ Cart for "${row.request_text}" expired - nobody confirmed in time.`,
        ).catch((err) => console.error("Failed to post expiry notice:", err));
      }
    }, remaining);
    expiryTimers.set(row.whatsapp_msg_id, timer);
  }
}
