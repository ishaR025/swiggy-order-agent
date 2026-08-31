import "../ledger/db.js";
import { resolveOrder } from "../swiggy/resolveOrder.js";
import { placeOrder } from "../swiggy/placeOrder.js";

/**
 * Manual verification script (plan step 3) - resolves a request AND places it for
 * real, with a hard-coded confirmation prompt printed to the terminal first. This
 * intentionally is NOT reachable from WhatsApp; it exists only so a human can
 * verify placeOrder() against the live Swiggy MCP servers before wiring the
 * WhatsApp confirm flow in step 4.
 *
 *   npm run place-test -- "get one pack of medium dustbin bags"
 */
async function main() {
  const text = process.argv.slice(2).join(" ");
  if (!text) {
    console.error('Usage: npm run place-test -- "get one pack of medium dustbin bags"');
    process.exit(1);
  }

  const resolved = await resolveOrder(text);
  console.log("\nResolved cart:");
  console.log(JSON.stringify(resolved, null, 2));

  console.log(
    `\nThis will place a REAL order for ₹${resolved.total} via ${resolved.paymentMethod}.`,
  );
  console.log('Re-run with CONFIRM=1 to actually place it, e.g.:');
  console.log(`  CONFIRM=1 npm run place-test -- "${text}"`);

  if (process.env.CONFIRM !== "1") {
    console.log("\nCONFIRM not set - stopping before placing the order.");
    return;
  }

  const result = await placeOrder(resolved);
  console.log("\nplaceOrder result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
