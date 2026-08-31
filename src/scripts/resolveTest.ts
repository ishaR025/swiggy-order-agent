import "../ledger/db.js";
import { resolveOrder } from "../swiggy/resolveOrder.js";

/**
 * Manual verification script (see the plan's step-3 verification):
 *   npm run resolve-test -- "get milk and eggs"
 * Requires a valid token for both services already pushed via `npm run swiggy-login`.
 * Prints the resolved cart. Never places an order - resolveOrder() has no access to
 * place_food_order/checkout/confirm_order/check_payment_status.
 */
async function main() {
  const text = process.argv.slice(2).join(" ") || "get milk and eggs";
  console.log(`Resolving: "${text}"\n`);
  const resolved = await resolveOrder(text);
  console.log(JSON.stringify(resolved, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
