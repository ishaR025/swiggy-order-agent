import { createServer } from "node:http";
import { config, requireForRuntime } from "./config.js";
import { startWhatsAppWebhook, sendMessage, type IncomingChatMessage } from "./whatsapp/client.js";
import { parseIntent } from "./commands/parseIntent.js";
import { requestOrder, confirmOrder, rehydratePendingOrders } from "./orders/pendingOrders.js";
import {
  createSchedule,
  cancelSchedules,
  rehydrateSchedules,
  rehydrateNudges,
  clearNudgeExpiry,
} from "./scheduler/cron.js";
import { getBalances, getActiveNudgeForSender, markNudgeResolved } from "./ledger/queries.js";
import { storeToken, getTokenStatus, type SwiggyService } from "./swiggy/token.js";
import "./ledger/db.js"; // ensures tables exist before anything else runs

requireForRuntime();

function main() {
  startWhatsAppWebhook({
    onMessage: (msg) => {
      handleMessage(msg).catch((err) => console.error("Error handling message:", err));
    },
    onReaction: (reaction) => {
      if (reaction.emoji !== "👍") return; // ignore removals and other emoji
      confirmOrder(reaction.targetMessageId).catch((err) =>
        console.error("Error confirming via reaction:", err),
      );
    },
  });

  rehydratePendingOrders();
  rehydrateSchedules();
  rehydrateNudges();
  startAdminServer();

  checkTokenHealth();
  setInterval(checkTokenHealth, 60 * 60 * 1000); // hourly
}

async function handleMessage(msg: IncomingChatMessage) {
  // A reply to an outstanding scheduled-order nudge reopens the 24h window and is
  // the trigger to actually resolve + send the real cart - consume it here, before
  // normal intent parsing, regardless of what the reply text says.
  const nudge = getActiveNudgeForSender(msg.from);
  if (nudge) {
    markNudgeResolved(nudge.id);
    clearNudgeExpiry(nudge.id);
    await requestOrder(msg.from, nudge.intent_text);
    return;
  }

  const intent = parseIntent(msg);

  switch (intent.type) {
    case "confirm":
      await confirmOrder(intent.whatsappMsgId);
      break;
    case "order":
      await requestOrder(msg.from, intent.text);
      break;
    case "schedule_create":
      await createSchedule(msg.from, intent.text);
      break;
    case "schedule_cancel":
      await cancelSchedules(msg.from);
      break;
    case "balance":
      await sendMessage(msg.from, formatBalances());
      break;
    case "ignore":
      break;
  }
}

function formatBalances(): string {
  const balances = getBalances();
  if (balances.length === 0) return "No placed orders yet.";
  const lines = balances.map((b) => `  ${b.jid}: ₹${b.totalPlaced.toFixed(2)}`);
  return ["💰 Placed-order totals:", ...lines].join("\n");
}

function checkTokenHealth() {
  for (const service of ["food", "instamart"] as SwiggyService[]) {
    const status = getTokenStatus(service);
    let warning: string | null = null;
    if (status.state === "expired" || status.state === "missing") {
      warning = `⚠️ Swiggy ${service} login is ${status.state}. Run \`npm run swiggy-login\` and push the new token, or orders will fail.`;
    } else if (status.state === "expiring_soon") {
      warning = `⚠️ Swiggy ${service} login expires in ~${status.hoursLeft}h. Run \`npm run swiggy-login\` soon.`;
    }
    if (!warning) continue;
    for (const number of config.allowedNumbers) {
      sendMessage(number, warning).catch((err) =>
        console.error(`Failed to post token warning to ${number}:`, err),
      );
    }
  }
}

/**
 * Minimal local admin server: a health check and the endpoint `npm run swiggy-login`
 * PUTs a freshly-obtained token to. Bind to localhost only and reach it over an SSH
 * tunnel or a firewall rule scoped to your own IP - see .env.example. This is separate
 * from the public WhatsApp webhook server (different port, localhost-only).
 */
function startAdminServer() {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }

    if (req.method === "PUT" && req.url === "/admin/token") {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${config.adminTokenSecret}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { service, accessToken, expiresAt } = JSON.parse(body) as {
            service: SwiggyService;
            accessToken: string;
            expiresAt: string;
          };
          if (service !== "food" && service !== "instamart") {
            throw new Error("service must be 'food' or 'instamart'");
          }
          storeToken(service, accessToken, new Date(expiresAt));
          res.writeHead(200).end("ok");
        } catch (err) {
          res.writeHead(400).end(err instanceof Error ? err.message : "bad request");
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(config.adminPort, "127.0.0.1", () => {
    console.log(`Admin server listening on 127.0.0.1:${config.adminPort}`);
  });
}

main();
