import { createServer } from "node:http";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { storeToken, type SwiggyService } from "../swiggy/token.js";

const CALLBACK_PORT = 51789;
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`;

const SERVERS: Record<SwiggyService, string> = {
  food: "https://mcp.swiggy.com/food",
  instamart: "https://mcp.swiggy.com/im",
};

// Dynamic Client Registration (RFC 7591) results are cached per service so we don't
// re-register a new OAuth client on every login - only the user-facing authorize+token
// exchange needs to be repeated every 5 days.
const CLIENT_INFO_PATH = "./auth/swiggy-oauth-clients.json";

function loadClientInfoCache(): Record<string, OAuthClientInformationMixed> {
  if (!existsSync(CLIENT_INFO_PATH)) return {};
  return JSON.parse(readFileSync(CLIENT_INFO_PATH, "utf8"));
}

function saveClientInfoCache(cache: Record<string, OAuthClientInformationMixed>) {
  mkdirSync(dirname(CLIENT_INFO_PATH), { recursive: true });
  writeFileSync(CLIENT_INFO_PATH, JSON.stringify(cache, null, 2));
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log(`Could not auto-open a browser. Open this URL manually:\n${url}`);
    }
  });
}

function waitForCallbackCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URL);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        error
          ? `<p>Login failed: ${error}. You can close this tab.</p>`
          : `<p>Login complete. You can close this tab and return to the terminal.</p>`,
      );
      server.close();
      if (error) reject(new Error(`Authorization error: ${error}`));
      else if (code) resolve(code);
      else reject(new Error("Callback had no code or error"));
    });
    server.listen(CALLBACK_PORT);
  });
}

function makeProvider(
  service: SwiggyService,
  clientInfoCache: Record<string, OAuthClientInformationMixed>,
): OAuthClientProvider {
  let codeVerifier: string | undefined;

  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [REDIRECT_URL],
    client_name: "swiggy-order-agent (household bot)",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  return {
    get redirectUrl() {
      return REDIRECT_URL;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    clientInformation() {
      return clientInfoCache[service];
    },
    saveClientInformation(info: OAuthClientInformationMixed) {
      clientInfoCache[service] = info;
      saveClientInfoCache(clientInfoCache);
    },
    tokens() {
      // Always force a fresh interactive login from this script - it's the tool
      // specifically for obtaining a new 5-day token, not for reusing an old one.
      return undefined;
    },
    saveTokens(tokens: OAuthTokens) {
      const expiresAt = new Date(
        Date.now() + (tokens.expires_in ?? 5 * 24 * 3600) * 1000,
      );
      storeToken(service, tokens.access_token, expiresAt);
      console.log(
        `Saved ${service} token locally, expires ${expiresAt.toISOString()}`,
      );
    },
    redirectToAuthorization(authorizationUrl: URL) {
      console.log(`\nOpening browser for ${service} login (phone + OTP)...`);
      openBrowser(authorizationUrl.toString());
    },
    saveCodeVerifier(verifier: string) {
      codeVerifier = verifier;
    },
    codeVerifier() {
      if (!codeVerifier) throw new Error("No PKCE code verifier saved yet");
      return codeVerifier;
    },
  };
}

async function loginToService(
  service: SwiggyService,
  clientInfoCache: Record<string, OAuthClientInformationMixed>,
) {
  console.log(`\n=== Logging in to Swiggy ${service} MCP ===`);

  const provider = makeProvider(service, clientInfoCache);
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[service]), {
    authProvider: provider,
  });
  const client = new Client({ name: "swiggy-order-agent-login", version: "0.1.0" });

  const callbackPromise = waitForCallbackCode();

  try {
    await client.connect(transport);
    // If connect() succeeds without throwing, an existing valid session was found -
    // shouldn't normally happen since tokens() always returns undefined above.
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }

  const code = await callbackPromise;
  await transport.finishAuth(code);
  await client.connect(transport);
  await client.close();

  console.log(`${service}: login complete.`);
}

async function main() {
  const clientInfoCache = loadClientInfoCache();
  for (const service of Object.keys(SERVERS) as SwiggyService[]) {
    await loginToService(service, clientInfoCache);
  }
  console.log("\nAll done. Tokens are stored in the local DB (DB_PATH).");
  console.log(
    "If this bot runs on a VPS, push these tokens there via the /admin/token endpoint (see DEPLOY.md) rather than copying the DB file.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
