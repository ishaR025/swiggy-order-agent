import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage as HttpIncomingMessage,
  type ServerResponse,
} from "node:http";
import { config } from "../config.js";

// WhatsApp Cloud API - verified directly against Meta's own docs:
// send-message endpoint/body shape, the incoming text-message webhook shape,
// and the GET verification handshake (hub.mode/hub.verify_token/hub.challenge).
// The reaction payload shape below (type: "reaction", {message_id, emoji}) was
// cross-checked against several independent WhatsApp API providers rather than
// Meta's own page directly (it didn't render for me) - confirm it empirically
// against a real incoming reaction once the webhook is live.
const GRAPH_API_VERSION = "v23.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type IncomingChatMessage = {
  messageId: string;
  from: string; // WhatsApp number, e.g. "919804340701"
  text: string;
  /** Set when this message is a WhatsApp "reply" quoting another message. */
  contextMessageId?: string;
};

export type ReactionEvent = {
  from: string;
  targetMessageId: string;
  emoji: string; // "" means the reaction was removed
};

export type MessageHandlers = {
  onMessage: (msg: IncomingChatMessage) => void;
  onReaction: (reaction: ReactionEvent) => void;
};

export function isAllowedSender(from: string): boolean {
  return config.allowedNumbers.includes(from);
}

async function postMessage(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${GRAPH_BASE}/${config.metaPhoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Meta send message failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { messages?: { id: string }[] };
  const id = data.messages?.[0]?.id;
  if (!id) throw new Error("Meta send message response had no message id");
  return id;
}

/** Sends a free-form text message. Only deliverable within the 24h window after
 * the recipient last messaged the bot - use sendTemplateMessage() outside that
 * window (e.g. a scheduled trigger with no recent inbound message). */
export async function sendMessage(to: string, text: string): Promise<string> {
  return postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  });
}

/** Sends a pre-approved message template - required for any bot-initiated
 * message outside the 24h customer-service window (e.g. scheduled triggers).
 * The template must already exist and be APPROVED in the Meta dashboard/API
 * before this will work. */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
): Promise<string> {
  return postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length
        ? { components: [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }] }
        : {}),
    },
  });
}

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.metaAppSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return (
    expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
  );
}

function handleVerify(req: HttpIncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", `http://localhost:${config.metaWebhookPort}`);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === config.metaWebhookVerifyToken && challenge) {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(challenge);
  } else {
    res.writeHead(403).end();
  }
}

function processWebhookBody(body: unknown, handlers: MessageHandlers): void {
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const messages = (value?.messages as Record<string, unknown>[] | undefined) ?? [];

      for (const m of messages) {
        const from = m.from as string | undefined;
        const id = m.id as string | undefined;
        if (!from || !id || !isAllowedSender(from)) continue;

        if (m.type === "text") {
          const text = (m.text as { body?: string } | undefined)?.body;
          if (!text) continue;
          const contextMessageId = (m.context as { id?: string } | undefined)?.id;
          handlers.onMessage({ messageId: id, from, text, contextMessageId });
        } else if (m.type === "reaction") {
          const reaction = m.reaction as { message_id?: string; emoji?: string } | undefined;
          if (reaction?.message_id) {
            handlers.onReaction({
              from,
              targetMessageId: reaction.message_id,
              emoji: reaction.emoji ?? "",
            });
          }
        }
      }
    }
  }
}

function handleIncoming(
  req: HttpIncomingMessage,
  res: ServerResponse,
  handlers: MessageHandlers,
) {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);

    if (!verifySignature(rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
      res.writeHead(401).end();
      return;
    }

    // Ack immediately - Meta retries the webhook on a non-200 or timeout.
    res.writeHead(200).end("EVENT_RECEIVED");

    try {
      processWebhookBody(JSON.parse(rawBody.toString("utf8")), handlers);
    } catch (err) {
      console.error("Failed to process webhook body:", err);
    }
  });
}

/**
 * Starts the public webhook server Meta calls for verification (GET /webhook)
 * and incoming events (POST /webhook). Must be reachable over public HTTPS -
 * see deploy/DEPLOY.md for exposing this (a domain + TLS on the VPS, or a
 * tunnel like ngrok/cloudflared for local development).
 */
export function startWhatsAppWebhook(handlers: MessageHandlers): void {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/webhook")) {
      handleVerify(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/webhook") {
      handleIncoming(req, res, handlers);
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(config.metaWebhookPort, () => {
    console.log(`WhatsApp webhook listening on port ${config.metaWebhookPort} (path /webhook)`);
  });
}
