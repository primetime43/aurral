import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth, requirePermission, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { enqueueSystemTaskJob } from "../services/honkerDb.ts";
import {
  connectHistoryServer,
  disconnectHistoryServer,
  HISTORY_SERVER_PROVIDERS,
  HistoryServerError,
  listHistoryServers,
} from "../services/historyServers.ts";
import {
  completePlexHistoryAuth,
  endPlexHistoryAuth,
  getPlexHistoryConnection,
  startPlexHistoryAuth,
} from "../services/plexHistoryAuth.ts";
import { logger } from "../services/logger.ts";
import { asAppError } from "../../lib/errors.ts";
import {
  clearPlexLibraryStatusCache,
  createPlexMusicLibrary,
  getPlexMusicLibraryStatus,
  PlexLibrarySetupError,
} from "../services/plexLibrarySetup.ts";

const providerParam = v.object({ provider: v.picklist(HISTORY_SERVER_PROVIDERS) });
const connectBody = v.object({
  url: v.string(),
  username: v.string(),
  secret: v.optional(v.string()),
});
const plexOauthTransactionBody = v.object({ transactionId: v.string() });
const plexOauthConnectBody = v.object({
  transactionId: v.string(),
  serverId: v.string(),
  url: v.string(),
});
const plexLibraryBody = v.object({ name: v.string(), folderPath: v.string() });

const queueSync = (userId: number, provider: string) =>
  enqueueSystemTaskJob({ kind: "history-server-sync", userId, provider });

export default new Hono<AppEnv>()
  .basePath("/history-servers")
  .get("/", requireAuth, requireUserAccount, async (c) => {
    const servers = listHistoryServers(c.var.user.id);
    let plexMusicLibrary: boolean | null = null;
    if (servers.some((server) => server.provider === "plex")) {
      try {
        plexMusicLibrary = (await getPlexMusicLibraryStatus(c.var.user.id)).hasMusicLibrary;
      } catch {
        // A history connection can remain usable even when library management is unavailable.
      }
    }
    return c.json(
      {
        servers: servers.map((server) => ({
          ...server,
          plexMusicLibrary: server.provider === "plex" ? plexMusicLibrary : null,
        })),
      },
      200,
    );
  })
  .get("/plex/library", requirePermission("accessSettings"), requireUserAccount, async (c) => {
    try {
      return c.json(await getPlexMusicLibraryStatus(c.var.user.id, { force: true }), 200);
    } catch (error) {
      const failure = asAppError(error);
      const status = error instanceof PlexLibrarySetupError ? error.status : 502;
      return c.json({ error: failure?.message || "Could not read Plex libraries" }, status);
    }
  })
  .post(
    "/plex/library",
    requirePermission("accessSettings"),
    requireUserAccount,
    validate("json", plexLibraryBody),
    async (c) => {
      try {
        return c.json(await createPlexMusicLibrary(c.var.user.id, c.req.valid("json")), 200);
      } catch (error) {
        const failure = asAppError(error);
        const status = error instanceof PlexLibrarySetupError ? error.status : 502;
        logger.warn("listening", "Could not create Plex music library", {
          message: failure?.message,
          status: failure?.response?.status ?? status,
        });
        return c.json({ error: failure?.message || "Could not create Plex music library" }, status);
      }
    },
  )
  .post("/plex/oauth/start", requirePermission("accessSettings"), requireUserAccount, async (c) => {
    try {
      return c.json(await startPlexHistoryAuth(c.var.user.id), 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("listening", "Could not start Plex sign-in", {
        message: failure?.message,
        status: failure?.response?.status ?? null,
      });
      return c.json({ error: "Couldn't start Plex sign-in" }, 502);
    }
  })
  .post(
    "/plex/oauth/complete",
    requirePermission("accessSettings"),
    requireUserAccount,
    validate("json", plexOauthTransactionBody),
    async (c) => {
      try {
        return c.json(
          await completePlexHistoryAuth(c.var.user.id, c.req.valid("json").transactionId),
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        const status = Number(failure?.status) === 400 ? 400 : 502;
        logger.warn("listening", "Could not complete Plex sign-in", {
          message: failure?.message,
          status: failure?.response?.status ?? failure?.status ?? null,
        });
        return c.json(
          {
            error:
              status === 400 ? failure?.message || "Plex sign-in expired" : "Plex sign-in failed",
          },
          status,
        );
      }
    },
  )
  .post(
    "/plex/oauth/connect",
    requirePermission("accessSettings"),
    requireUserAccount,
    validate("json", plexOauthConnectBody),
    async (c) => {
      const { transactionId, serverId, url: selectedUrl } = c.req.valid("json");
      try {
        const connection = getPlexHistoryConnection(
          c.var.user.id,
          transactionId,
          serverId,
          selectedUrl,
        );
        const url = validateExternalUrl(connection.url);
        if (!url.valid) return c.json({ error: url.error }, 400);
        const server = await connectHistoryServer(c.var.user.id, "plex", {
          ...connection,
          url: url.url,
        });
        clearPlexLibraryStatusCache(c.var.user.id);
        endPlexHistoryAuth(transactionId);
        queueSync(c.var.user.id, "plex");
        return c.json({ server }, 200);
      } catch (error) {
        if (error instanceof HistoryServerError) return c.json({ error: error.message }, 400);
        const failure = asAppError(error);
        if (Number(failure?.status) === 400) {
          return c.json({ error: failure?.message || "Invalid Plex connection" }, 400);
        }
        logger.warn("listening", "Could not connect the Plex history server", {
          message: failure?.message,
          status: failure?.response?.status ?? null,
        });
        const status = Number(failure?.response?.status);
        return c.json(
          {
            error:
              status === 401 || status === 403
                ? "Plex rejected that login"
                : "Couldn't reach the Plex server",
          },
          400,
        );
      }
    },
  )
  .put(
    "/:provider",
    requirePermission("accessSettings"),
    requireUserAccount,
    validate("param", providerParam),
    validate("json", connectBody),
    async (c) => {
      const { provider } = c.req.valid("param");
      const body = c.req.valid("json");
      const url = validateExternalUrl(body.url);
      const username = body.username.trim();
      if (!url.valid) return c.json({ error: url.error }, 400);
      if (!username) return c.json({ error: "Enter a username" }, 400);
      try {
        const server = await connectHistoryServer(c.var.user.id, provider, {
          url: url.url,
          username,
          secret: body.secret?.trim() || null,
        });
        if (provider === "plex") clearPlexLibraryStatusCache(c.var.user.id);
        queueSync(c.var.user.id, provider);
        return c.json({ server }, 200);
      } catch (error) {
        if (error instanceof HistoryServerError) return c.json({ error: error.message }, 400);
        const failure = asAppError(error);
        logger.warn("listening", "Could not connect a listening history server", {
          provider,
          message: failure?.message,
          status: failure?.response?.status ?? null,
        });
        const status = Number(failure?.response?.status);
        return c.json(
          {
            error:
              status === 401 || status === 403
                ? "The server rejected that login"
                : "Couldn't reach the server",
          },
          400,
        );
      }
    },
  )
  .post(
    "/:provider/sync",
    requireAuth,
    requireUserAccount,
    validate("param", providerParam),
    (c) => {
      queueSync(c.var.user.id, c.req.valid("param").provider);
      return c.body(null, 202);
    },
  )
  .delete(
    "/:provider",
    requireAuth,
    requireUserAccount,
    validate("param", providerParam),
    async (c) => {
      const provider = c.req.valid("param").provider;
      await disconnectHistoryServer(c.var.user.id, provider);
      if (provider === "plex") clearPlexLibraryStatusCache(c.var.user.id);
      return c.body(null, 204);
    },
  );
