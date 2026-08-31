import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  adminTokenSecret: process.env.ADMIN_TOKEN_SECRET ?? "",
  adminPort: Number(process.env.ADMIN_PORT ?? "8787"),
  dbPath: process.env.DB_PATH ?? "./data/bot.db",

  // WhatsApp Cloud API (Meta)
  metaAccessToken: process.env.META_ACCESS_TOKEN ?? "",
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
  metaWebhookPort: Number(process.env.META_WEBHOOK_PORT ?? "8788"),
  // Only needed for src/scripts/setupWhatsAppTemplate.ts (template creation/status
  // checks use the WABA id; sending a message only needs the phone number id above).
  metaWabaId: process.env.META_WABA_ID ?? "",
  // Comma-separated WhatsApp numbers (E.164 without "+", e.g. "919804340701")
  // allow-listed to talk to the bot - the two flatmates.
  allowedNumbers: (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
};

export function requireForRuntime() {
  required("ANTHROPIC_API_KEY");
  required("ADMIN_TOKEN_SECRET");
  required("META_ACCESS_TOKEN");
  required("META_PHONE_NUMBER_ID");
  required("META_APP_SECRET");
  required("META_WEBHOOK_VERIFY_TOKEN");
  if (config.allowedNumbers.length === 0) {
    throw new Error("WHATSAPP_ALLOWED_NUMBERS must list at least one number");
  }
}
