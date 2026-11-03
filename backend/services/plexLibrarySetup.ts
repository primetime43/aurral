import axios from "../../lib/axiosFetch.ts";
import { asAppError } from "../../lib/errors.ts";
import {
  getSuggestedDownloadFolderPath,
  getStoredDownloadFolderPath,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.ts";
import { getHistoryServerConnection } from "./historyServers.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const STATUS_CACHE_MS = 15_000;

type PlexMusicLibrary = {
  id: string;
  title: string;
  locations: string[];
  refreshing: boolean;
};

export type PlexMusicLibraryStatus = {
  hasMusicLibrary: boolean;
  libraries: PlexMusicLibrary[];
  suggestedPath: string;
  needsSharedMount: boolean;
};

export class PlexLibrarySetupError extends Error {
  status: 400 | 403 | 502;

  constructor(message: string, status: 400 | 403 | 502 = 400) {
    super(message);
    this.name = "PlexLibrarySetupError";
    this.status = status;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const text = (value: unknown) => String(value || "").trim();
const boolean = (value: unknown) => value === true || value === 1 || value === "1";

function plexHeaders(token: string, clientId: string | null) {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": clientId || "aurral",
    "X-Plex-Product": "Aurral",
  };
}

function parseMusicLibraries(data: unknown): PlexMusicLibrary[] {
  const container = record(record(data).MediaContainer);
  return list(container.Directory).flatMap((value) => {
    const section = record(value);
    if (text(section.type) !== "artist") return [];
    const id = text(section.key) || text(section.id);
    if (!id) return [];
    return [
      {
        id,
        title: text(section.title) || "Music",
        locations: list(section.Location)
          .map((location) => text(record(location).path))
          .filter(Boolean),
        refreshing: boolean(section.refreshing),
      },
    ];
  });
}

const statusCache = new Map<number, { expiresAt: number; value: PlexMusicLibraryStatus }>();

export function clearPlexLibraryStatusCache(userId?: number) {
  if (userId == null) statusCache.clear();
  else statusCache.delete(userId);
}

export async function getPlexMusicLibraryStatus(userId: number, { force = false } = {}) {
  const cached = statusCache.get(userId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const connection = getHistoryServerConnection(userId, "plex");
  if (!connection) throw new PlexLibrarySetupError("Connect Plex before setting up its library.");
  const baseUrl = connection.url.replace(/\/+$/, "");
  const headers = plexHeaders(connection.secret, connection.clientId);
  try {
    const { data } = await axios.get(`${baseUrl}/library/sections`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const libraries = parseMusicLibraries(data);
    const configuredPath = getStoredDownloadFolderPath() || resolveEnvDownloadFolder();
    const value = {
      hasMusicLibrary: libraries.length > 0,
      libraries,
      suggestedPath: configuredPath || getSuggestedDownloadFolderPath(),
      needsSharedMount: !configuredPath,
    };
    statusCache.set(userId, { expiresAt: Date.now() + STATUS_CACHE_MS, value });
    return value;
  } catch (error) {
    const failure = asAppError(error);
    const status = Number(failure?.response?.status);
    if (status === 401 || status === 403) {
      throw new PlexLibrarySetupError("Plex rejected the saved connection. Sign in again.", 403);
    }
    throw new PlexLibrarySetupError("Aurral could not read the Plex libraries.", 502);
  }
}

function normalizePlexFolderPath(value: unknown) {
  const folderPath = text(value);
  if (!folderPath || folderPath.length > 1_024 || folderPath.includes("\0")) {
    throw new PlexLibrarySetupError("Enter the folder path as the Plex server sees it.");
  }
  const absolute =
    folderPath.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(folderPath) ||
    /^\\\\[^\\]+\\[^\\]+/.test(folderPath);
  if (!absolute) {
    throw new PlexLibrarySetupError("The Plex folder must be an absolute path.");
  }
  if (folderPath === "/" || /^[a-z]:[\\/]?$/i.test(folderPath)) {
    throw new PlexLibrarySetupError("Choose the music folder, not the root of a drive.");
  }
  return folderPath.replace(/[\\/]+$/, "");
}

export async function createPlexMusicLibrary(
  userId: number,
  { name, folderPath }: { name: string; folderPath: string },
) {
  const connection = getHistoryServerConnection(userId, "plex");
  if (!connection) throw new PlexLibrarySetupError("Connect Plex before creating its library.");
  const existing = await getPlexMusicLibraryStatus(userId, { force: true });
  if (existing.hasMusicLibrary) return { created: false, status: existing };

  const libraryName = text(name) || "Aurral Music";
  if (libraryName.length > 100) throw new PlexLibrarySetupError("Library name is too long.");
  const location = normalizePlexFolderPath(folderPath);
  const baseUrl = connection.url.replace(/\/+$/, "");
  const headers = plexHeaders(connection.secret, connection.clientId);
  try {
    await axios.post(`${baseUrl}/library/sections`, null, {
      params: {
        name: libraryName,
        type: "artist",
        agent: "tv.plex.agents.music",
        language: "en-US",
        location,
      },
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const failure = asAppError(error);
    const status = Number(failure?.response?.status);
    if (status === 401 || status === 403) {
      throw new PlexLibrarySetupError(
        "Plex did not allow library creation. Reconnect with the server owner's account.",
        403,
      );
    }
    if (status === 400) {
      throw new PlexLibrarySetupError(
        "Plex could not use that folder. Enter the path as the Plex server sees it and make sure Plex can read it.",
      );
    }
    throw new PlexLibrarySetupError("Aurral could not create the Plex music library.", 502);
  }

  clearPlexLibraryStatusCache(userId);
  const status = await getPlexMusicLibraryStatus(userId, { force: true });
  const library =
    status.libraries.find((entry) => entry.title === libraryName) || status.libraries[0];
  if (!library) {
    throw new PlexLibrarySetupError(
      "Plex accepted the request but the music library did not appear. Check Plex and try again.",
      502,
    );
  }
  await axios
    .get(`${baseUrl}/library/sections/${encodeURIComponent(library.id)}/refresh`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    })
    .catch(() => {});
  clearPlexLibraryStatusCache(userId);
  return {
    created: true,
    status: {
      ...status,
      libraries: status.libraries.map((entry) =>
        entry.id === library.id ? { ...entry, refreshing: true } : entry,
      ),
    },
  };
}
