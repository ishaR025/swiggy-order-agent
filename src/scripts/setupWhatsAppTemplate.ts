import { config } from "../config.js";
import {
  SCHEDULE_NUDGE_TEMPLATE_NAME,
  SCHEDULE_NUDGE_TEMPLATE_LANGUAGE,
  SCHEDULE_NUDGE_TEMPLATE_BODY,
} from "../whatsapp/templates.js";

// Verified against Meta's Template API docs:
//   POST /{waba-id}/message_templates
//   { name, category, language, components: [{type:"BODY", text, example:{body_text:[[...]]}}] }
// Status check: GET /{waba-id}/message_templates?name=<name>
const GRAPH_API_VERSION = "v23.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function main() {
  if (!config.metaWabaId) {
    throw new Error("META_WABA_ID is required for this script (not needed at bot runtime).");
  }

  const statusArg = process.argv.includes("--status");

  if (statusArg) {
    const res = await fetch(
      `${GRAPH_BASE}/${config.metaWabaId}/message_templates?name=${SCHEDULE_NUDGE_TEMPLATE_NAME}`,
      { headers: { Authorization: `Bearer ${config.metaAccessToken}` } },
    );
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Creating template "${SCHEDULE_NUDGE_TEMPLATE_NAME}"...`);
  const res = await fetch(`${GRAPH_BASE}/${config.metaWabaId}/message_templates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: SCHEDULE_NUDGE_TEMPLATE_NAME,
      category: "UTILITY",
      language: SCHEDULE_NUDGE_TEMPLATE_LANGUAGE,
      components: [
        {
          type: "BODY",
          text: SCHEDULE_NUDGE_TEMPLATE_BODY,
          example: { body_text: [["lunch from usual place"]] },
        },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed (${res.status}):`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
  console.log(
    `\nSubmitted for review. Check status with: npm run setup-whatsapp-template -- --status`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
