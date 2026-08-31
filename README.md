# Swiggy Order Agent

A persistent bot that lets two people in a shared WhatsApp group order Swiggy
food/Instamart in plain language, see the resolved cart, and confirm with a
👍 or "yes" before anything is actually placed. Also tracks a running
who-ordered-what ledger and supports recurring orders (e.g. weekday lunch).

**This places real orders with real money.** There is no sandbox/test mode -
see [CLAUDE.md](./CLAUDE.md) for the rules the ordering logic follows.

## How it works

1. Someone posts something like `order 2 rotis and dal from usual place` or
   `get milk and eggs` in the WhatsApp group.
2. The bot calls Claude with Swiggy's MCP servers attached via the
   [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector),
   but only search/cart-building tools are enabled - `place_food_order`,
   `checkout`, `confirm_order`, and `check_payment_status` are excluded, so
   this step can never place an order on its own.
3. The resolved cart (items, restaurant/store, total, payment method) is
   posted back to the group.
4. Only a 👍 reaction or a "yes" reply from either person triggers the
   actual order - via a separate, deterministic MCP client call that
   replays exactly the cart that was shown, with no LLM involved.
5. Placed orders are logged to a local SQLite ledger so the group can ask
   for a running balance.
6. Recurring requests ("order lunch every weekday at 1pm") register a cron
   job that re-resolves and re-posts a fresh cart each time - it never
   skips the confirmation step, even on a schedule.

## Stack

- **Baileys** - unofficial WhatsApp Web client (QR login, no browser/Selenium).
- **Claude API** (`claude-opus-5`) - order resolution via the MCP connector,
  with structured output ([Zod](https://zod.dev) schema) and a runtime check
  that rejects any response referencing a disallowed tool.
- **`@modelcontextprotocol/sdk`** - a plain MCP client used only to place an
  already-approved order, plus a spec-compliant OAuth 2.1 + PKCE + Dynamic
  Client Registration flow for logging into Swiggy's MCP servers.
- **better-sqlite3** - ledger + schedules, single local file.
- **node-cron** - recurring schedule triggers.

## Setup

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and ADMIN_TOKEN_SECRET
npm run group-setup    # scan the QR, copy your group's JID into .env
npm run swiggy-login   # phone + OTP login for both food and instamart
npm run dev
```

See [deploy/DEPLOY.md](./deploy/DEPLOY.md) for running this persistently on
a small VPS (recommended - see below).

## Why a VPS, not a laptop

This needs to stay online continuously to catch group messages and fire
scheduled orders. A laptop that sleeps, reboots, or loses wifi will miss
messages and can destabilize the linked WhatsApp session. Swiggy's OAuth
tokens also only last 5 days with no refresh token, so `npm run swiggy-login`
needs to be re-run periodically (the bot posts a warning in-group when a
token is close to expiring or already gone) - `deploy/DEPLOY.md` covers
pushing a freshly-obtained token to a remote deployment.

## Known limitations

- Baileys is an unofficial protocol implementation, not the official
  WhatsApp Business API - it can join an existing group (which the official
  API cannot without business verification), but at the cost of running on
  a personal number against an unofficial client, with the ToS/ban risk
  that implies for 24/7 automated use.
- No refresh tokens for Swiggy's MCP servers (v1.0) - the 5-day manual
  re-login is unavoidable for now.
