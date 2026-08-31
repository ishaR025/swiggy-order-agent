import { db } from "./db.js";
import type { ResolvedOrder } from "../swiggy/resolveOrder.js";

export type OrderStatus = "pending_confirmation" | "placed" | "failed" | "expired";

export type OrderRow = {
  id: number;
  whatsapp_msg_id: string;
  requester_jid: string;
  requester_name: string | null;
  request_text: string;
  service: string;
  restaurant_or_store: string | null;
  items_json: string;
  total_amount: number;
  payment_method: string;
  place_order_tool: string;
  place_order_args_json: string;
  status: OrderStatus;
  swiggy_order_id: string | null;
  created_at: string;
  confirmed_at: string | null;
};

const insertStmt = db.prepare(`
  INSERT INTO orders (
    whatsapp_msg_id, requester_jid, requester_name, request_text, service,
    restaurant_or_store, items_json, total_amount, payment_method,
    place_order_tool, place_order_args_json
  ) VALUES (@whatsappMsgId, @requesterJid, @requesterName, @requestText, @service,
    @restaurantOrStore, @itemsJson, @totalAmount, @paymentMethod,
    @placeOrderTool, @placeOrderArgsJson)
`);

export function insertPendingOrder(params: {
  whatsappMsgId: string;
  requesterJid: string;
  requesterName: string | null;
  requestText: string;
  resolved: ResolvedOrder;
}): void {
  insertStmt.run({
    whatsappMsgId: params.whatsappMsgId,
    requesterJid: params.requesterJid,
    requesterName: params.requesterName,
    requestText: params.requestText,
    service: params.resolved.service,
    restaurantOrStore: params.resolved.restaurantOrStore,
    itemsJson: JSON.stringify(params.resolved.items),
    totalAmount: params.resolved.total,
    paymentMethod: params.resolved.paymentMethod,
    placeOrderTool: params.resolved.placeOrderTool,
    placeOrderArgsJson: JSON.stringify(params.resolved.placeOrderArgs),
  });
}

export function getOrderByMessageId(whatsappMsgId: string): OrderRow | undefined {
  return db
    .prepare(`SELECT * FROM orders WHERE whatsapp_msg_id = ?`)
    .get(whatsappMsgId) as OrderRow | undefined;
}

export function getPendingOrders(): OrderRow[] {
  return db
    .prepare(`SELECT * FROM orders WHERE status = 'pending_confirmation'`)
    .all() as OrderRow[];
}

export function markOrderPlaced(whatsappMsgId: string, swiggyOrderId: string): void {
  db.prepare(
    `UPDATE orders SET status = 'placed', swiggy_order_id = ?, confirmed_at = datetime('now')
     WHERE whatsapp_msg_id = ?`,
  ).run(swiggyOrderId, whatsappMsgId);
}

export function markOrderFailed(whatsappMsgId: string): void {
  db.prepare(
    `UPDATE orders SET status = 'failed', confirmed_at = datetime('now') WHERE whatsapp_msg_id = ?`,
  ).run(whatsappMsgId);
}

export function markOrderExpired(whatsappMsgId: string): void {
  db.prepare(`UPDATE orders SET status = 'expired' WHERE whatsapp_msg_id = ?`).run(
    whatsappMsgId,
  );
}

export type Balance = { jid: string; totalPlaced: number };

export function getBalances(): Balance[] {
  return db
    .prepare(
      `SELECT requester_jid AS jid, SUM(total_amount) AS totalPlaced
       FROM orders WHERE status = 'placed' GROUP BY requester_jid`,
    )
    .all() as Balance[];
}
