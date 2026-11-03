import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

vi.mock("../../backend/services/honkerDb.ts", () => ({
  enqueueSystemTaskJob: () => ({ enqueued: true }),
}));

const [state, { db }, { userOps }, historyServers, historyServerRoutes] =
  await setupIsolatedBackend(
    "plex-history-oauth",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/historyServers.ts"),
    () => import("../../backend/routes/historyServers.ts"),
  );

const originalFetch = globalThis.fetch;
let userId: number;

beforeEach(() => {
  resetDatabase(db);
  userId = userOps.createUser("admin", "hash", "admin")!.id;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const jsonPost = (app: ReturnType<typeof signedInAs>, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

test("Plex sign-in discovers owned servers and saves the selected history connection", async () => {
  let authorized = false;
  const requests: {
    path: string;
    token: string | null;
    product: string | null;
    clientId: string | null;
  }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      token: request.headers.get("x-plex-token"),
      product: request.headers.get("x-plex-product"),
      clientId: request.headers.get("x-plex-client-identifier"),
    });
    if (url.pathname === "/api/v2/pins" && request.method === "POST") {
      return Response.json({ id: 42, code: "plex-code" });
    }
    if (url.pathname === "/api/v2/pins/42") {
      return Response.json({
        id: 42,
        code: "plex-code",
        authToken: authorized ? "account-token" : null,
      });
    }
    if (url.pathname === "/api/v2/user") {
      return Response.json({ id: 7, username: "OwnerName" });
    }
    if (url.pathname === "/api/v2/resources") {
      return Response.json([
        {
          name: "Music Server",
          clientIdentifier: "owned-server",
          provides: "server",
          owned: true,
          accessToken: "server-token",
          connections: [
            { uri: "http://192.168.1.10:32400", local: true, relay: false },
            { uri: "https://remote.example:32400", local: false, relay: false },
          ],
        },
        {
          name: "Shared Server",
          clientIdentifier: "shared-server",
          provides: "server",
          owned: false,
          accessToken: "shared-token",
          connections: [{ uri: "https://shared.example:32400", local: false }],
        },
      ]);
    }
    if (url.pathname === "/accounts") {
      assert.equal(request.headers.get("x-plex-token"), "server-token");
      return Response.json({
        MediaContainer: { Account: [{ id: 1, name: "OwnerName" }] },
      });
    }
    throw new Error(`Unexpected Plex request: ${request.method} ${url}`);
  };

  const app = signedInAs(testUser(userId, { role: "admin" })).route(
    "/",
    historyServerRoutes.default,
  );
  const startedResponse = await jsonPost(app, "/history-servers/plex/oauth/start");
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  assert.match(started.authUrl, /^https:\/\/app\.plex\.tv\/auth#/);
  assert.ok(started.transactionId);

  const pendingResponse = await jsonPost(app, "/history-servers/plex/oauth/complete", {
    transactionId: started.transactionId,
  });
  assert.deepEqual(await pendingResponse.json(), { pending: true });

  authorized = true;
  const completedResponse = await jsonPost(app, "/history-servers/plex/oauth/complete", {
    transactionId: started.transactionId,
  });
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.username, "OwnerName");
  assert.deepEqual(
    completed.servers.map((server: { id: string; name: string }) => [server.id, server.name]),
    [["owned-server", "Music Server"]],
  );
  assert.equal(JSON.stringify(completed).includes("server-token"), false);
  assert.equal(JSON.stringify(completed).includes("account-token"), false);

  const connectResponse = await jsonPost(app, "/history-servers/plex/oauth/connect", {
    transactionId: started.transactionId,
    serverId: "owned-server",
    url: "http://192.168.1.10:32400",
  });
  assert.equal(connectResponse.status, 200);
  assert.deepEqual(
    historyServers.listHistoryServers(userId).map((server) => ({
      provider: server.provider,
      url: server.url,
      username: server.username,
    })),
    [{ provider: "plex", url: "http://192.168.1.10:32400", username: "OwnerName" }],
  );
  assert.ok(requests.every((request) => request.product === "Aurral"));
  assert.equal(
    requests.find((request) => request.path === "/api/v2/resources")?.token,
    "account-token",
  );
  assert.equal(
    requests.find((request) => request.path === "/accounts")?.clientId,
    requests.find((request) => request.path === "/api/v2/resources")?.clientId,
  );
});

test("a Plex OAuth transaction cannot select a connection Plex did not return", async () => {
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === "/api/v2/pins" && request.method === "POST") {
      return Response.json({ id: 5, code: "code" });
    }
    if (url.pathname === "/api/v2/pins/5") {
      return Response.json({ id: 5, code: "code", authToken: "account-token" });
    }
    if (url.pathname === "/api/v2/user") return Response.json({ username: "Owner" });
    if (url.pathname === "/api/v2/resources") {
      return Response.json([
        {
          name: "Server",
          clientIdentifier: "server-id",
          provides: "server",
          owned: 1,
          accessToken: "server-token",
          connections: [{ uri: "http://plex.test:32400", local: 1 }],
        },
      ]);
    }
    throw new Error(`Unexpected Plex request: ${request.method} ${url}`);
  };

  const app = signedInAs(testUser(userId, { role: "admin" })).route(
    "/",
    historyServerRoutes.default,
  );
  const started = await (await jsonPost(app, "/history-servers/plex/oauth/start")).json();
  await jsonPost(app, "/history-servers/plex/oauth/complete", {
    transactionId: started.transactionId,
  });
  const response = await jsonPost(app, "/history-servers/plex/oauth/connect", {
    transactionId: started.transactionId,
    serverId: "server-id",
    url: "http://attacker.example:32400",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Choose a connection returned by Plex." });
  assert.deepEqual(historyServers.listHistoryServers(userId), []);
});
