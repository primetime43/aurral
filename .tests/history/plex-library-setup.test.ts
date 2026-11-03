import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

vi.mock("../../backend/services/honkerDb.ts", () => ({
  enqueueSystemTaskJob: () => ({ enqueued: true }),
}));

const [state, { db }, { userOps }, historyServers, plexLibrarySetup] = await setupIsolatedBackend(
  "plex-library-setup",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/historyServers.ts"),
  () => import("../../backend/services/plexLibrarySetup.ts"),
);

const originalFetch = globalThis.fetch;
let userId: number;

beforeEach(() => {
  resetDatabase(db);
  plexLibrarySetup.clearPlexLibraryStatusCache();
  userId = userOps.createUser("admin", "hash", "admin")!.id;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("Aurral creates and scans a missing Plex music library", async () => {
  let created = false;
  const requests: { method: string; path: string; params: URLSearchParams }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname, params: url.searchParams });
    if (url.pathname === "/accounts") {
      return Response.json({ MediaContainer: { Account: [{ id: 1, name: "Owner" }] } });
    }
    if (url.pathname === "/library/sections" && request.method === "GET") {
      return Response.json({
        MediaContainer: {
          Directory: created
            ? [
                {
                  key: "12",
                  type: "artist",
                  title: "Aurral Music",
                  refreshing: false,
                  Location: [{ path: "/music/aurral" }],
                },
              ]
            : [{ key: "1", type: "movie", title: "Movies" }],
        },
      });
    }
    if (url.pathname === "/library/sections" && request.method === "POST") {
      created = true;
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/library/sections/12/refresh") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Plex request: ${request.method} ${url}`);
  };

  await historyServers.connectHistoryServer(userId, "plex", {
    url: "http://plex.test:32400",
    username: "Owner",
    secret: "server-token",
    clientId: "aurral-client",
  });

  const before = await plexLibrarySetup.getPlexMusicLibraryStatus(userId);
  assert.equal(before.hasMusicLibrary, false);
  const result = await plexLibrarySetup.createPlexMusicLibrary(userId, {
    name: "Aurral Music",
    folderPath: "/music/aurral",
  });
  assert.equal(result.created, true);
  assert.equal(result.status.hasMusicLibrary, true);
  assert.equal(result.status.libraries[0]?.refreshing, true);

  const createRequest = requests.find(
    (request) => request.method === "POST" && request.path === "/library/sections",
  );
  assert.equal(createRequest?.params.get("name"), "Aurral Music");
  assert.equal(createRequest?.params.get("type"), "artist");
  assert.equal(createRequest?.params.get("agent"), "tv.plex.agents.music");
  assert.equal(createRequest?.params.get("location"), "/music/aurral");
  assert.ok(requests.some((request) => request.path === "/library/sections/12/refresh"));
});

test("library creation rejects a path that is not absolute", async () => {
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === "/accounts") {
      return Response.json({ MediaContainer: { Account: [{ id: 1, name: "Owner" }] } });
    }
    if (url.pathname === "/library/sections") {
      return Response.json({ MediaContainer: { Directory: [] } });
    }
    throw new Error(`Unexpected Plex request: ${request.method} ${url}`);
  };

  await historyServers.connectHistoryServer(userId, "plex", {
    url: "http://plex.test:32400",
    username: "Owner",
    secret: "server-token",
  });
  await assert.rejects(
    plexLibrarySetup.createPlexMusicLibrary(userId, {
      name: "Aurral Music",
      folderPath: "music/aurral",
    }),
    /absolute path/,
  );
});
