import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";
import { config } from "../config.js";

const logger = pino({ level: "silent" });

export type IncomingGroupMessage = {
  messageId: string;
  groupJid: string;
  senderJid: string;
  text: string;
  /** Set when this message is a WhatsApp "reply" (swipe-to-reply) quoting another message. */
  quotedMessageId?: string;
};

export type ReactionEvent = {
  groupJid: string;
  reactorJid: string;
  targetMessageId: string;
  emoji: string; // "" means the reaction was removed
};

export type WhatsAppHandlers = {
  onGroupMessage: (msg: IncomingGroupMessage) => void;
  onReaction: (reaction: ReactionEvent) => void;
};

/**
 * Connects to WhatsApp Web via Baileys, persisting session credentials to
 * WHATSAPP_AUTH_DIR so a restart doesn't require re-scanning the QR code.
 * Reconnects automatically on any disconnect except an explicit logout.
 */
export async function connectWhatsApp(
  handlers: WhatsAppHandlers,
): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(
    config.whatsappAuthDir,
  );

  const sock = makeWASocket({
    auth: state,
    logger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR code with WhatsApp (Linked Devices):");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `WhatsApp connection closed (${statusCode ?? "unknown"}). Reconnecting: ${shouldReconnect}`,
      );
      if (shouldReconnect) {
        connectWhatsApp(handlers).catch((err) =>
          console.error("Reconnect failed:", err),
        );
      } else {
        console.error(
          "Logged out of WhatsApp. Delete the auth directory and re-run to scan a fresh QR code.",
        );
      }
    } else if (connection === "open") {
      console.log("WhatsApp connection open.");
    }
  });

  sock.ev.on("messages.upsert", (event) => {
    if (event.type !== "notify") return;
    for (const m of event.messages) {
      if (m.key.fromMe) continue;
      const groupJid = m.key.remoteJid;
      if (!groupJid || groupJid !== config.whatsappGroupJid) continue;

      const text =
        m.message?.conversation ??
        m.message?.extendedTextMessage?.text ??
        undefined;
      if (!text) continue;

      const senderJid = m.key.participant ?? groupJid;
      const messageId = m.key.id;
      if (!messageId) continue;

      const quotedMessageId =
        m.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined;

      handlers.onGroupMessage({ messageId, groupJid, senderJid, text, quotedMessageId });
    }
  });

  // Verified against Baileys source (src/Utils/process-message.ts): reactions
  // arrive on their own "messages.reaction" event, not via messages.update.
  sock.ev.on("messages.reaction", (reactions) => {
    for (const r of reactions) {
      const groupJid = r.reaction.key?.remoteJid;
      if (!groupJid || groupJid !== config.whatsappGroupJid) continue;

      const targetMessageId = r.key?.id;
      if (!targetMessageId) continue;

      const reactorJid = r.reaction.key?.participant ?? groupJid;
      const emoji = r.reaction.text ?? "";

      handlers.onReaction({ groupJid, reactorJid, targetMessageId, emoji });
    }
  });

  return sock;
}

/**
 * Sends a text message to the configured group and returns the sent
 * message's id, which callers store to later match confirmations against.
 */
export async function sendGroupMessage(
  sock: WASocket,
  text: string,
): Promise<string> {
  const sent = await sock.sendMessage(config.whatsappGroupJid, { text });
  const id = sent?.key?.id;
  if (!id) {
    throw new Error("sendMessage did not return a message id");
  }
  return id;
}
