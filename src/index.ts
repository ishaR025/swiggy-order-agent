import { createServer } from "node:http";
import { config, requireForRuntime } from "./config.js";
import { connectWhatsApp, sendGroupMessage, type IncomingGroupMessage } from "./whatsapp/client.js";
import { parseIntent } from "./commands/parseIntent.js";
import { requestOrder, confirmOrder, rehydratePendingOrders } from "./orders/pendingOrders.js";
import { createSchedule, cancelSchedules, rehydrateSchedules } from "./scheduler/cron.js";
import { getBalances } from "./ledger/queries.js";
import { storeToken, getTokenStatus, type SwiggyService } from "./swiggy/token.js";
import "./ledger/db.js"; // ensures tables exist before anything else runs

requireForRuntime();

async function main() {
  const sock = await connectWhatsApp({
    onGroupMessage: (msg) => {
      handleGroupMessage(sock, msg).catch((err) =>
        console.error("Error handling group message:", err),
      );
    },
    onReaction: (reaction) => {
      if (reaction.emoji !== "👍") return; // ignore removals and other emoji
      confirmOrder(sock, reaction.targetMessageId).catch((err) =>
        console.error("Error confirming via reaction:", err),
      );
    },
  });

  rehydratePendingOrders(sock);
  rehydrateSchedules(sock);
  startAdminServer();

  checkTokenHealth(sock);
  setInterval(() => checkTokenHealth(sock), 60 * 60 * 1000); // hourly
}

async function handleGroupMessage(sock: Awaited<ReturnType<typeof connectWhatsApp>>, msg: IncomingGroupMessage) {
  const intent = parseIntent(msg);

  switch (intent.type) {
    case "confirm":
      await confirmOrder(sock, intent.whatsappMsgId);
      break;
    case "order":
      await requestOrder(sock, msg.senderJid, intent.text);
      break;
    case "schedule_create":
      await createSchedule(sock, msg.senderJid, intent.text);
      break;
    case "schedule_cancel":
      await cancelSchedules(sock);
      break;
    case "balance":
      await sendGroupMessage(sock, formatBalances());
      break;
    case "ignore":
      break;
  }
}

function formatBalances(): string {
  const balances = getBalances();
  if (balances.length === 0) return "No placed orders yet.";
  const lines = balances.map((b) => `  ${b.jid.split("@")[0]}: ₹${b.totalPlaced.toFixed(2)}`);
  return ["💰 Placed-order totals:", ...lines].join("\n");
}

function checkTokenHealth(sock: Awaited<ReturnType<typeof connectWhatsApp>>) {
  for (const service of ["food", "instamart"] as SwiggyService[]) {
    const status = getTokenStatus(service);
    if (status.state === "expired" || status.state === "missing") {
      sendGroupMessage(
        sock,
        `⚠️ Swiggy ${service} login is ${status.state}. Run \`npm run swiggy-login\` and push the new token, or orders will fail.`,
      ).catch((err) => console.error("Failed to post token warning:", err));
    } else if (status.state === "expiring_soon") {
      sendGroupMessage(
        sock,
        `⚠️ Swiggy ${service} login expires in ~${status.hoursLeft}h. Run \`npm run swiggy-login\` soon.`,
      ).catch((err) => console.error("Failed to post token warning:", err));
    }
  }
}

/**
 * Minimal local admin server: a health check and the endpoint `npm run swiggy-login`
 * PUTs a freshly-obtained token to. Bind to localhost only and reach it over an SSH
 * tunnel or a firewall rule scoped to your own IP - see .env.example.
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

main().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
