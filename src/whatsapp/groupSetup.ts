import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";
import { config } from "../config.js";

/**
 * One-time setup: scan the QR code, then list every group this WhatsApp
 * account is in so you can copy the right JID into WHATSAPP_GROUP_JID.
 * Run with: npm run group-setup
 */
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(
    config.whatsappAuthDir,
  );
  const sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }) });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log("Scan this QR code with WhatsApp (Linked Devices):");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error("Logged out. Delete the auth directory and re-run to scan a fresh QR code.");
        return;
      }
      // Expected right after a fresh scan (restartRequired) and on other transient
      // drops - Baileys needs a reconnect to finish registering with full creds.
      console.log(`Connection closed (${statusCode ?? "unknown"}), reconnecting...`);
      connect().catch((err) => console.error("Reconnect failed:", err));
      return;
    }

    if (connection === "open") {
      console.log("Connected. Fetching your groups...\n");
      const groups = await sock.groupFetchAllParticipating();
      const entries = Object.values(groups);
      if (entries.length === 0) {
        console.log("No groups found on this account.");
      } else {
        for (const g of entries) {
          console.log(`${g.subject}\n  JID: ${g.id}\n`);
        }
        console.log(
          "Copy the JID for your household group into WHATSAPP_GROUP_JID in .env, then Ctrl+C.",
        );
      }
    }
  });
}

connect().catch((err) => {
  console.error(err);
  process.exit(1);
});
