import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { requireAccessToken } from "./token.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MCP_CLIENT_BETA = "mcp-client-2025-11-20";

// Tool names as documented at https://mcp.swiggy.com/builders/docs/reference/{food,instamart}.
// Deliberately excludes every money-moving tool (place_food_order, checkout, confirm_order,
// check_payment_status) - this call may only search and build a cart, never place one.
// Per https://platform.claude.com/docs/en/agents-and-tools/mcp-connector: an unrecognized name in
// `configs` just logs a backend warning, it does not error - so a typo here fails closed (that
// tool silently stays unavailable) rather than failing open. Still worth confirming empirically in
// src/scripts/resolveTest.ts that Claude actually sees and uses the tools we expect.
const FOOD_ALLOWED_TOOLS = [
  "get_addresses",
  "search_restaurants",
  "get_restaurant_menu",
  "search_menu",
  "get_food_cart",
  "update_food_cart",
  "fetch_food_coupons",
  "apply_food_coupon",
  "flush_food_cart",
];

const INSTAMART_ALLOWED_TOOLS = [
  "get_addresses",
  "search_products",
  "get_cart",
  "update_cart",
  "clear_cart",
  "your_go_to_items",
];

const RESOLVE_SYSTEM_PROMPT = `You are the ordering brain for a household Swiggy WhatsApp bot. You resolve a
natural-language request into a concrete, priced cart. You do NOT place orders - the tools
available to you cannot place or confirm an order even if you try; a human will approve your
result over WhatsApp afterwards, and a separate deterministic step places it.

Rules (same as the household's interactive Swiggy agent):
1. Always resolve the delivery address via get_addresses before searching. If there are multiple
   saved addresses, prefer the one most recently used unless the request specifies otherwise.
2. Only recommend restaurants/products that are open/in-stock (availabilityStatus "OPEN" for
   restaurants; isInStockAndAvailable for Instamart items).
3. Builders Club v1 caps: max 1000 (currency units) per food cart. Check current Instamart caps
   from tool responses rather than assuming one.
4. Default to Cash on Delivery / COD unless the request explicitly asks for UPI.
5. If a request is ambiguous (e.g. "usual place" with no prior order history available to you,
   or multiple plausible matches), make the single most reasonable choice and clearly note the
   assumption you made in your final summary rather than asking a follow-up question - there is
   no human to answer one mid-turn.
6. Never guess a tool name or parameter; only use what the tool schemas/results tell you.

Produce exactly one final structured result describing the resolved cart.`;

const ResolvedOrderSchema = z.object({
  service: z.enum(["food", "instamart"]),
  restaurantOrStore: z.string(),
  items: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().int().positive(),
      price: z.number(),
    }),
  ),
  total: z.number(),
  addressId: z.string(),
  paymentMethod: z.enum(["COD", "UPI"]),
  assumptionsMade: z.array(z.string()),
  placeOrderTool: z.enum(["place_food_order", "checkout"]),
  placeOrderArgs: z.record(z.string(), z.unknown()),
});

export type ResolvedOrder = z.infer<typeof ResolvedOrderSchema>;

const DISALLOWED_TOOL_NAMES = [
  "place_food_order",
  "checkout",
  "confirm_order",
  "check_payment_status",
];

/**
 * Turns a free-text request ("order 2 rotis and dal from usual place") into a
 * concrete, priced cart by giving Claude read/cart-building-only access to the
 * real Swiggy MCP servers via the MCP connector. Never places an order.
 */
export async function resolveOrder(requestText: string): Promise<ResolvedOrder> {
  // food and instamart are independently-authorized resources (see token.ts) - each needs
  // its own token even though a single resolve call can use both servers.
  const foodToken = requireAccessToken("food");
  const instamartToken = requireAccessToken("instamart");

  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 8000,
    betas: [MCP_CLIENT_BETA],
    system: RESOLVE_SYSTEM_PROMPT,
    mcp_servers: [
      {
        type: "url",
        url: "https://mcp.swiggy.com/food",
        name: "swiggy-food",
        authorization_token: foodToken,
      },
      {
        type: "url",
        url: "https://mcp.swiggy.com/im",
        name: "swiggy-instamart",
        authorization_token: instamartToken,
      },
    ],
    tools: [
      {
        type: "mcp_toolset",
        mcp_server_name: "swiggy-food",
        default_config: { enabled: false },
        configs: Object.fromEntries(
          FOOD_ALLOWED_TOOLS.map((name) => [name, { enabled: true }]),
        ),
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "swiggy-instamart",
        default_config: { enabled: false },
        configs: Object.fromEntries(
          INSTAMART_ALLOWED_TOOLS.map((name) => [name, { enabled: true }]),
        ),
      },
    ],
    output_config: { format: betaZodOutputFormat(ResolvedOrderSchema) },
    messages: [{ role: "user", content: requestText }],
  });

  logToolsUsed(response.content);
  assertNoDisallowedToolUse(response.content);

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Claude refused to resolve this order: ${JSON.stringify(response.stop_details)}`,
    );
  }

  const textBlock = response.content.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  if (!textBlock) {
    throw new Error("No structured text output returned from resolveOrder");
  }

  return ResolvedOrderSchema.parse(JSON.parse(textBlock.text));
}

function logToolsUsed(content: unknown): void {
  if (!Array.isArray(content)) return;
  const names = content
    .filter(
      (b): b is { type: string; name: string; server_name?: string } =>
        !!b && typeof b === "object" && b.type === "mcp_tool_use",
    )
    .map((b) => `${b.server_name ?? "?"}/${b.name}`);
  console.log(`resolveOrder used tools: ${names.length ? names.join(", ") : "(none)"}`);
}

function assertNoDisallowedToolUse(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "mcp_tool_use" &&
      "name" in block &&
      DISALLOWED_TOOL_NAMES.includes((block as { name: string }).name)
    ) {
      throw new Error(
        `Safety check failed: resolveOrder's response referenced a disallowed tool "${(block as { name: string }).name}". Refusing to trust this result.`,
      );
    }
  }
}
