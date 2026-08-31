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
  whatsappGroupJid: process.env.WHATSAPP_GROUP_JID ?? "",
  adminTokenSecret: process.env.ADMIN_TOKEN_SECRET ?? "",
  adminPort: Number(process.env.ADMIN_PORT ?? "8787"),
  dbPath: process.env.DB_PATH ?? "./data/bot.db",
  whatsappAuthDir: process.env.WHATSAPP_AUTH_DIR ?? "./auth",
};

export function requireForRuntime() {
  required("ANTHROPIC_API_KEY");
  required("WHATSAPP_GROUP_JID");
  required("ADMIN_TOKEN_SECRET");
}
