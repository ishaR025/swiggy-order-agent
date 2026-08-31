import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { requireAccessToken } from "./token.js";
import type { ResolvedOrder } from "./resolveOrder.js";

const SERVER_URL: Record<ResolvedOrder["service"], string> = {
  food: "https://mcp.swiggy.com/food",
  instamart: "https://mcp.swiggy.com/im",
};

export type PlaceOrderResult = {
  raw: unknown;
  isError: boolean;
  summaryText: string;
};

/**
 * Deterministically replays an already-approved resolution: calls exactly
 * `resolved.placeOrderTool` with exactly `resolved.placeOrderArgs` against the
 * real Swiggy MCP server. No LLM is involved in this step - the decision was
 * already made (and approved by a human over WhatsApp) by resolveOrder().
 */
export async function placeOrder(
  resolved: Pick<ResolvedOrder, "service" | "placeOrderTool" | "placeOrderArgs">,
): Promise<PlaceOrderResult> {
  const token = requireAccessToken(resolved.service);

  const transport = new StreamableHTTPClientTransport(
    new URL(SERVER_URL[resolved.service]),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  );

  const client = new Client({ name: "swiggy-order-agent", version: "0.1.0" });

  try {
    await client.connect(transport);

    const result = await client.callTool(
      {
        name: resolved.placeOrderTool,
        arguments: resolved.placeOrderArgs,
      },
      CallToolResultSchema,
    );

    const isError = "isError" in result && result.isError === true;
    const content = "content" in result && Array.isArray(result.content)
      ? result.content
      : [];
    const summaryText = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block,
      )
      .map((block) => block.text)
      .join("\n");

    return { raw: result, isError, summaryText };
  } finally {
    await client.close();
  }
}
