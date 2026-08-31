# Swiggy Order Agent

A persistent bot that lets two people each DM it on WhatsApp to order Swiggy
food/Instamart in plain language, see the resolved cart, and confirm with a
👍 or "yes" before anything is actually placed. Also tracks a running
who-ordered-what ledger and supports recurring orders (e.g. weekday lunch).

**This places real orders with real money.** There is no sandbox/test mode -
see [CLAUDE.md](./CLAUDE.md) for the rules the ordering logic follows.

## How it works

1. Either person DMs the bot's WhatsApp number with something like
   `order 2 rotis and dal from usual place` or `get milk and eggs`.
2. The bot calls Claude with Swiggy's MCP servers attached via the
   [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector),
   but only search/cart-building tools are enabled - `place_food_order`,
   `checkout`, `confirm_order`, and `check_payment_status` are excluded, so
   this step can never place an order on its own.
3. The resolved cart (items, restaurant/store, total, payment method) is
   sent back to that same person.
4. Only a 👍 reaction or a "yes" reply from that person triggers the actual
   order - via a separate, deterministic MCP client call that replays
   exactly the cart that was shown, with no LLM involved. Each person's
   orders/confirmations are independent of the other's.
5. Placed orders are logged to a local SQLite ledger; either person can ask
   the bot for a running balance across both of you.
6. Recurring requests ("order lunch every weekday at 1pm") register a cron
   job that re-resolves and re-sends a fresh cart each time - it never
   skips the confirmation step, even on a schedule.

## Stack

- **WhatsApp Cloud API** (Meta's official Business Platform) - a webhook
  server for incoming messages/reactions plus the Graph API for sending.
  Official and ToS-safe, at the cost of no group-chat support (see
  "Why DMs, not a group" below) and a public HTTPS endpoint requirement.
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
cp .env.example .env
```

You'll need, from a Meta Developer app with the WhatsApp product added:
`META_ACCESS_TOKEN` (a System User token - see deploy/DEPLOY.md for getting
a permanent one, not the 24h default), `META_PHONE_NUMBER_ID`,
`META_APP_SECRET`, and a `META_WEBHOOK_VERIFY_TOKEN` you choose yourself.
Add both flatmates' numbers to `WHATSAPP_ALLOWED_NUMBERS` - and, if you're on
Meta's free test-number tier, also allow-list them as recipient numbers in
the dashboard (no business verification needed for up to 5 numbers).

The webhook (`/webhook` on `META_WEBHOOK_PORT`) must be reachable over public
HTTPS for Meta to deliver events to it - see deploy/DEPLOY.md for exposing it
via a tunnel (local dev) or a domain+TLS (VPS).

```bash
npm run swiggy-login   # phone + OTP login for both food and instamart
npm run dev
```

See [deploy/DEPLOY.md](./deploy/DEPLOY.md) for running this persistently on
a small VPS (recommended - see below).

## Why DMs, not a group

The WhatsApp Cloud API has no concept of group chats at all - it's built
around 1:1 business-to-customer messaging (business-initiated messages plus
user replies within a 24-hour session window). An earlier version of this
bot used an unofficial WhatsApp Web client (Baileys) specifically to get
group support, at the cost of ToS/ban risk on a personal number for 24/7
automation. This version trades the shared thread for the official, ToS-safe
API - each person gets their own DM thread with the bot instead.

One real consequence: the 24-hour window means the bot can only send
free-form text after that person has messaged it recently. A scheduled
trigger (e.g. daily lunch) firing outside that window needs a pre-approved
WhatsApp message template instead - not yet wired in here, so until a
template exists and is approved, the scheduled nudge only works if you've
messaged the bot within the last 24h.

## Why a VPS, not a laptop

This needs to stay online continuously to catch messages and fire scheduled
orders, and its webhook needs a stable public HTTPS endpoint - a laptop that
sleeps, reboots, or loses wifi breaks both. Swiggy's OAuth tokens also only
last 5 days with no refresh token, so `npm run swiggy-login` needs to be
re-run periodically (the bot DMs both of you a warning when a token is close
to expiring or already gone) - `deploy/DEPLOY.md` covers pushing a
freshly-obtained token to a remote deployment.

## Known limitations

- No group chat - see "Why DMs, not a group" above.
- Scheduled (cron) triggers need an approved WhatsApp message template to
  reliably fire outside a 24h active window - not yet built.
- No refresh tokens for Swiggy's MCP servers (v1.0) - the 5-day manual
  re-login is unavoidable for now.
