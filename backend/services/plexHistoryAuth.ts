import crypto from "node:crypto";
import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { readMany, readOne } from "./integrationData.ts";

const PLEX_TV = "https://plex.tv";
const PLEX_AUTH_APP = "https://app.plex.tv";
const PLEX_PRODUCT = "Aurral";
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const pinSchema = v.looseObject({
  id: v.union([v.string(), v.number()]),
  code: v.string(),
  authToken: v.optional(v.nullable(v.string())),
});
const identitySchema = v.looseObject({
  username: v.optional(v.string()),
  title: v.optional(v.string()),
  email: v.optional(v.string()),
});
const connectionSchema = v.looseObject({
  uri: v.string(),
  local: v.optional(v.union([v.boolean(), v.string(), v.number()])),
  relay: v.optional(v.union([v.boolean(), v.string(), v.number()])),
});
const connectionsSchema = v.union([v.array(connectionSchema), connectionSchema]);
const resourceSchema = v.looseObject({
  name: v.optional(v.string()),
  clientIdentifier: v.optional(v.string()),
  provides: v.optional(v.string()),
  owned: v.optional(v.union([v.boolean(), v.string(), v.number()])),
  accessToken: v.optional(v.string()),
  connections: v.optional(connectionsSchema),
  Connection: v.optional(connectionsSchema),
});

export type PlexHistoryServer = {
  id: string;
  name: string;
  connections: { uri: string; local: boolean; relay: boolean }[];
};

type AuthorizedServer = PlexHistoryServer & { token: string };
type PendingPlexHistoryAuth = {
  userId: number;
  pinId: string | number;
  code: string;
  clientId: string;
  expiresAt: number;
  username: string | null;
  servers: AuthorizedServer[] | null;
};

const pending = new Map<string, PendingPlexHistoryAuth>();

const truthy = (value: unknown) =>
  value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function plexHeaders(clientId: string, token?: string) {
  return {
    Accept: "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Version": "1.0",
    "X-Plex-Platform": "Node.js",
    "X-Plex-Platform-Version": process.version,
    "X-Plex-Device": "Server",
    "X-Plex-Device-Name": PLEX_PRODUCT,
    ...(token ? { "X-Plex-Token": token } : {}),
  };
}

function prune(now = Date.now()) {
  for (const [transactionId, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(transactionId);
  }
}

function requirePending(userId: number, transactionId: string) {
  prune();
  const entry = pending.get(transactionId);
  if (!entry || entry.userId !== userId || entry.expiresAt <= Date.now()) {
    throw Object.assign(new Error("Plex sign-in expired. Try again."), { status: 400 });
  }
  return entry;
}

function publicServers(servers: AuthorizedServer[]): PlexHistoryServer[] {
  return servers.map(({ id, name, connections }) => ({ id, name, connections }));
}

function resourceList(data: unknown) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const container = (data as { MediaContainer?: { Device?: unknown } }).MediaContainer;
  if (Array.isArray(container?.Device)) return container.Device;
  return container?.Device ? [container.Device] : [];
}

function usableUri(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

const asConnections = (value: v.InferOutput<typeof connectionsSchema> | undefined) =>
  value ? (Array.isArray(value) ? value : [value]) : [];

async function createPin(clientId: string) {
  const { data } = await axios.post(`${PLEX_TV}/api/v2/pins`, null, {
    params: { strong: true },
    headers: plexHeaders(clientId),
    timeout: REQUEST_TIMEOUT_MS,
  });
  return readOne(pinSchema, data, { service: "Plex", endpoint: "/api/v2/pins" });
}

async function checkPin(entry: PendingPlexHistoryAuth) {
  const { data } = await axios.get(`${PLEX_TV}/api/v2/pins/${entry.pinId}`, {
    params: { code: entry.code },
    headers: plexHeaders(entry.clientId),
    timeout: REQUEST_TIMEOUT_MS,
  });
  return (
    readOne(pinSchema, data, { service: "Plex", endpoint: "/api/v2/pins/:id" }).authToken || null
  );
}

async function readIdentity(token: string, clientId: string) {
  const { data } = await axios.get(`${PLEX_TV}/api/v2/user`, {
    headers: plexHeaders(clientId, token),
    timeout: REQUEST_TIMEOUT_MS,
  });
  return readOne(identitySchema, data, { service: "Plex", endpoint: "/api/v2/user" });
}

async function readOwnedServers(token: string, clientId: string) {
  const { data } = await axios.get(`${PLEX_TV}/api/v2/resources`, {
    params: { includeHttps: 1, includeRelay: 1 },
    headers: plexHeaders(clientId, token),
    timeout: REQUEST_TIMEOUT_MS,
  });
  return readMany(resourceSchema, resourceList(data), {
    service: "Plex",
    endpoint: "/api/v2/resources",
  }).flatMap((resource): AuthorizedServer[] => {
    if (!String(resource.provides || "").includes("server") || !truthy(resource.owned)) return [];
    const id = text(resource.clientIdentifier);
    const serverToken = text(resource.accessToken) || token;
    if (!id || !serverToken) return [];
    const seen = new Set<string>();
    const connections = [
      ...asConnections(resource.connections),
      ...asConnections(resource.Connection),
    ].flatMap((connection) => {
      const uri = usableUri(connection.uri);
      if (!uri || seen.has(uri)) return [];
      seen.add(uri);
      return [{ uri, local: truthy(connection.local), relay: truthy(connection.relay) }];
    });
    if (!connections.length) return [];
    return [{ id, name: text(resource.name) || "Plex server", token: serverToken, connections }];
  });
}

export async function startPlexHistoryAuth(userId: number) {
  const clientId = crypto.randomUUID();
  const pin = await createPin(clientId);
  const transactionId = crypto.randomBytes(24).toString("hex");
  prune();
  for (const [id, entry] of pending) {
    if (entry.userId === userId) pending.delete(id);
  }
  pending.set(transactionId, {
    userId,
    pinId: pin.id,
    code: pin.code,
    clientId,
    expiresAt: Date.now() + TRANSACTION_TTL_MS,
    username: null,
    servers: null,
  });
  const query = new URLSearchParams({
    clientID: clientId,
    code: pin.code,
    "context[device][product]": PLEX_PRODUCT,
  });
  return { transactionId, authUrl: `${PLEX_AUTH_APP}/auth#?${query}` };
}

export async function completePlexHistoryAuth(userId: number, transactionId: string) {
  const entry = requirePending(userId, transactionId);
  if (entry.servers) {
    return {
      pending: false as const,
      username: entry.username,
      servers: publicServers(entry.servers),
    };
  }
  const token = await checkPin(entry);
  if (!token) return { pending: true as const };
  const identity = await readIdentity(token, entry.clientId);
  const username = text(identity.username) || text(identity.title) || text(identity.email);
  if (!username) {
    pending.delete(transactionId);
    throw Object.assign(new Error("Plex did not return an account name."), { status: 400 });
  }
  const servers = await readOwnedServers(token, entry.clientId);
  if (!servers.length) {
    pending.delete(transactionId);
    throw Object.assign(new Error("This Plex account does not own a reachable Plex server."), {
      status: 400,
    });
  }
  entry.username = username;
  entry.servers = servers;
  entry.expiresAt = Date.now() + TRANSACTION_TTL_MS;
  return { pending: false as const, username, servers: publicServers(servers) };
}

export function getPlexHistoryConnection(
  userId: number,
  transactionId: string,
  serverId: string,
  url: string,
) {
  const entry = requirePending(userId, transactionId);
  const server = entry.servers?.find((candidate) => candidate.id === serverId);
  if (!entry.username || !server) {
    throw Object.assign(new Error("Finish Plex sign-in before choosing a server."), {
      status: 400,
    });
  }
  const selectedUrl = usableUri(url);
  if (!server.connections.some((connection) => connection.uri === selectedUrl)) {
    throw Object.assign(new Error("Choose a connection returned by Plex."), { status: 400 });
  }
  return {
    url: selectedUrl,
    username: entry.username,
    secret: server.token,
    clientId: entry.clientId,
  };
}

export function endPlexHistoryAuth(transactionId: string) {
  pending.delete(transactionId);
}
