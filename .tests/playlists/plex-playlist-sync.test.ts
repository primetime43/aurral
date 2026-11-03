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

const [state, { db }, { userOps }, historyServers, plexPlaylistSync] = await setupIsolatedBackend(
  "plex-playlist-sync",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/historyServers.ts"),
  () => import("../../backend/services/plexPlaylistSync.ts"),
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

test("an Aurral playlist is created in Plex and later replaces the same playlist", async () => {
  const requests: {
    method: string;
    path: string;
    params: URLSearchParams;
    clientId: string | null;
  }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      params: url.searchParams,
      clientId: request.headers.get("x-plex-client-identifier"),
    });

    if (url.pathname === "/accounts") {
      return Response.json({ MediaContainer: { Account: [{ id: 1, name: "Owner" }] } });
    }
    if (url.pathname === "/identity") {
      return Response.json({
        MediaContainer: { machineIdentifier: "machine-1", version: "1.0" },
      });
    }
    if (url.pathname === "/library/sections") {
      return Response.json({
        MediaContainer: { Directory: [{ key: "1", type: "artist", title: "Music" }] },
      });
    }
    if (url.pathname === "/hubs/search") {
      const query = url.searchParams.get("query") || "";
      return Response.json({
        MediaContainer: {
          Hub: [
            {
              type: "track",
              Metadata: query.includes("Matched Song")
                ? [
                    {
                      type: "track",
                      ratingKey: "track-7",
                      title: "Matched Song",
                      grandparentTitle: "The Artist",
                      parentTitle: "The Album",
                      duration: 181000,
                    },
                  ]
                : [],
            },
          ],
        },
      });
    }
    if (url.pathname === "/playlists" && request.method === "POST") {
      return Response.json({
        MediaContainer: { Metadata: [{ ratingKey: "playlist-9", title: "Aurral Mix" }] },
      });
    }
    if (url.pathname === "/playlists/playlist-9" && request.method === "GET") {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "playlist-9" }] } });
    }
    if (url.pathname === "/playlists/playlist-9" && request.method === "PUT") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/playlists/playlist-9/items" && request.method === "DELETE") {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "playlist-9" }] } });
    }
    if (url.pathname === "/playlists/playlist-9/items" && request.method === "PUT") {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "playlist-9" }] } });
    }
    throw new Error(`Unexpected Plex request: ${request.method} ${url}`);
  };

  await historyServers.connectHistoryServer(userId, "plex", {
    url: "http://plex.test:32400",
    username: "Owner",
    secret: "server-token",
    clientId: "aurral-client",
  });

  const tracks = [
    {
      artistName: "The Artist",
      trackName: "Matched Song",
      albumName: "The Album",
      durationMs: 180000,
    },
    { artistName: "Missing Artist", trackName: "Missing Song" },
  ];
  const created = await plexPlaylistSync.syncPlaylistToPlex({
    userId,
    name: "Aurral Mix",
    tracks,
  });
  assert.equal(created.created, true);
  assert.equal(created.matchedTracks, 1);
  assert.equal(created.skippedTracks, 1);
  assert.equal(created.state.playlistId, "playlist-9");
  assert.equal(created.state.autoSync, false);
  assert.ok(created.state.contentFingerprint);
  assert.equal(created.state.lastSyncError, null);

  const createRequest = requests.find(
    (request) => request.path === "/playlists" && request.method === "POST",
  );
  assert.equal(createRequest?.params.get("type"), "audio");
  assert.equal(createRequest?.params.get("title"), "Aurral Mix");
  assert.equal(
    createRequest?.params.get("uri"),
    "server://machine-1/com.plexapp.plugins.library/library/metadata/track-7",
  );

  const updated = await plexPlaylistSync.syncPlaylistToPlex({
    userId,
    name: "Aurral Mix",
    tracks,
    previous: { ...created.state, autoSync: true },
  });
  assert.equal(updated.created, false);
  assert.equal(updated.state.autoSync, true);
  assert.equal(updated.state.contentFingerprint, created.state.contentFingerprint);
  assert.ok(
    requests.some(
      (request) => request.path === "/playlists/playlist-9/items" && request.method === "DELETE",
    ),
  );
  assert.ok(
    requests.some(
      (request) => request.path === "/playlists/playlist-9/items" && request.method === "PUT",
    ),
  );
  assert.ok(requests.every((request) => request.clientId === "aurral-client"));
});

test("playlist sync explains when Plex has no music library", async () => {
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === "/accounts") {
      return Response.json({ MediaContainer: { Account: [{ id: 1, name: "Owner" }] } });
    }
    if (url.pathname === "/identity") {
      return Response.json({ MediaContainer: { machineIdentifier: "machine-1" } });
    }
    if (url.pathname === "/library/sections") {
      return Response.json({
        MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }] },
      });
    }
    throw new Error(`Unexpected Plex request: ${request.method} ${url}`);
  };

  await historyServers.connectHistoryServer(userId, "plex", {
    url: "http://plex.test:32400",
    username: "Owner",
    secret: "server-token",
    clientId: "aurral-client",
  });

  await assert.rejects(
    plexPlaylistSync.syncPlaylistToPlex({
      userId,
      name: "Aurral Mix",
      tracks: [{ artistName: "The Artist", trackName: "Matched Song" }],
    }),
    /Plex server has no music library/,
  );
});
