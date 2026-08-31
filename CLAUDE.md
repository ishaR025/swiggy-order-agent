# Swiggy order agent

This project talks to real Swiggy MCP servers (`swiggy-food`, `swiggy-instamart` in
`.mcp.json`) via OAuth 2.1 + PKCE against the user's actual Swiggy account.
**Tool calls place real orders and spend real money.** There is no sandbox/test mode.

## Swiggy Builders Club docs

Before recommending a tool name, parameter, error code, rate limit, or auth flow,
fetch and verify against these docs — never invent them:

- Index:     https://mcp.swiggy.com/builders/llms.txt
- Full text: https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:  append `.md` to any https://mcp.swiggy.com/builders/docs/... URL

Tool schemas: `/docs/reference/{food,instamart}`. Errors: `/docs/reference/errors`.
Auth flow: `/docs/start/authenticate`. Recipes (canonical flows):
`/docs/build/recipes/order-food`, `/docs/build/recipes/order-groceries`,
`/docs/build/recipes/pay-with-upi`.

## Rules for this agent

1. Always resolve the address via `get_addresses` before searching.
2. Only recommend restaurants/products that are open/in-stock
   (`availabilityStatus: "OPEN"` for restaurants).
3. **Always show the final cart and total and get explicit user confirmation
   before calling `place_food_order` / `checkout` (instamart).** These calls are
   not idempotent and place real orders.
4. Builders Club v1 caps: ₹1000 per food cart. Check the reference docs for the
   current instamart cap before assuming one.
5. Default to COD unless the user asks to pay by UPI (see the Pay-with-UPI recipe
   for the different coupon-filtering rules that apply there).
6. On a 401, re-run the OAuth flow (access tokens last 5 days, no refresh tokens
   in v1.0) — don't just retry the call.
7. If `place_food_order`/`checkout` fails with a 5xx, call `get_food_orders` /
   `get_orders` to check whether the order actually went through before retrying.
8. Never guess a tool name or parameter that isn't in the reference docs — fetch
   and check first.
