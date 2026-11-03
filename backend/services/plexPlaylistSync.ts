import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { asAppError } from "../../lib/errors.ts";
import { getHistoryServerConnection } from "./historyServers.ts";
import { readOne } from "./integrationData.ts";
import {
  plexPlaylistContentFingerprint,
  type PlexPlaylistSyncState,
} from "./playlists/plexSyncState.ts";
import type { PlaylistTrackInput } from "./playlists/playlistTracks.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_CONCURRENCY = 5;

const identitySchema = v.looseObject({
  MediaContainer: v.looseObject({ machineIdentifier: v.string() }),
});
const searchSchema = v.looseObject({
  MediaContainer: v.looseObject({
    Hub: v.optional(v.union([v.array(v.unknown()), v.unknown()])),
  }),
});
const librarySectionsSchema = v.looseObject({
  MediaContainer: v.looseObject({
    Directory: v.optional(v.union([v.array(v.unknown()), v.unknown()])),
  }),
});
const playlistSchema = v.looseObject({
  MediaContainer: v.looseObject({
    Metadata: v.union([
      v.array(v.looseObject({ ratingKey: v.union([v.string(), v.number()]) })),
      v.looseObject({ ratingKey: v.union([v.string(), v.number()]) }),
    ]),
  }),
});

type PlexTrack = {
  ratingKey: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
};

export class PlexPlaylistSyncError extends Error {
  status: 400 | 502;

  constructor(message: string, status: 400 | 502 = 400) {
    super(message);
    this.name = "PlexPlaylistSyncError";
    this.status = status;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const normalize = (value: unknown) =>
  text(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function plexHeaders(token: string, clientId: string | null) {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": clientId || "aurral",
    "X-Plex-Product": "Aurral",
  };
}

function trackCandidates(data: unknown): PlexTrack[] {
  const parsed = readOne(searchSchema, data, { service: "Plex", endpoint: "/hubs/search" });
  return list(parsed.MediaContainer.Hub).flatMap((hubValue) => {
    const hub = record(hubValue);
    return list(hub.Metadata).flatMap((itemValue) => {
      const item = record(itemValue);
      if (text(item.type) !== "track") return [];
      const ratingKey = String(item.ratingKey || "").trim();
      const title = text(item.title);
      const artist = text(item.grandparentTitle);
      if (!ratingKey || !title || !artist) return [];
      const duration = Number(item.duration);
      return [
        {
          ratingKey,
          title,
          artist,
          album: text(item.parentTitle),
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        },
      ];
    });
  });
}

function artistKeys(track: PlaylistTrackInput) {
  const names = [
    track.artistName,
    ...(Array.isArray(track.artistAliases) ? track.artistAliases : []),
  ];
  const primary = text(track.artistName).split(/\s+(?:feat\.?|ft\.?|with|x)\s+/i)[0];
  return new Set([...names, primary].map(normalize).filter(Boolean));
}

function selectCandidate(track: PlaylistTrackInput, candidates: PlexTrack[]) {
  const expectedTitle = normalize(track.trackName);
  const expectedArtists = artistKeys(track);
  const expectedAlbum = normalize(track.albumName);
  const expectedDuration = Number(track.durationMs);
  return (
    candidates
      .filter(
        (candidate) =>
          normalize(candidate.title) === expectedTitle &&
          expectedArtists.has(normalize(candidate.artist)),
      )
      .map((candidate) => {
        let score = 0;
        if (expectedAlbum && normalize(candidate.album) === expectedAlbum) score += 10;
        if (
          Number.isFinite(expectedDuration) &&
          expectedDuration > 0 &&
          candidate.duration != null &&
          Math.abs(candidate.duration - expectedDuration) <= 5_000
        ) {
          score += 5;
        }
        return { candidate, score };
      })
      .sort((left, right) => right.score - left.score)[0]?.candidate || null
  );
}

async function matchTrack(
  baseUrl: string,
  headers: Record<string, string>,
  track: PlaylistTrackInput,
) {
  const artist = text(track.artistName);
  const title = text(track.trackName);
  if (!artist || !title) return null;
  const { data } = await axios.get(`${baseUrl}/hubs/search`, {
    params: { query: `${artist} ${title}`, limit: 10 },
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return selectCandidate(track, trackCandidates(data));
}

async function assertMusicLibrary(baseUrl: string, headers: Record<string, string>) {
  const { data } = await axios.get(`${baseUrl}/library/sections`, {
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const parsed = readOne(librarySectionsSchema, data, {
    service: "Plex",
    endpoint: "/library/sections",
  });
  const hasMusicLibrary = list(parsed.MediaContainer.Directory).some(
    (section) => text(record(section).type) === "artist",
  );
  if (!hasMusicLibrary) {
    throw new PlexPlaylistSyncError(
      "This Plex server has no music library. Add Aurral's music folder to a Plex music library, let Plex finish scanning, then try again.",
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const output: R[] = [];
  for (let start = 0; start < values.length; start += concurrency) {
    output.push(...(await Promise.all(values.slice(start, start + concurrency).map(mapper))));
  }
  return output;
}

function playlistIdFrom(data: unknown) {
  const parsed = readOne(playlistSchema, data, { service: "Plex", endpoint: "/playlists" });
  const metadata = Array.isArray(parsed.MediaContainer.Metadata)
    ? parsed.MediaContainer.Metadata[0]
    : parsed.MediaContainer.Metadata;
  const playlistId = String(metadata?.ratingKey || "").trim();
  if (!playlistId) throw new PlexPlaylistSyncError("Plex did not return the new playlist ID.", 502);
  return playlistId;
}

async function createPlaylist(
  baseUrl: string,
  headers: Record<string, string>,
  title: string,
  uri: string,
) {
  const { data } = await axios.post(`${baseUrl}/playlists`, null, {
    params: { type: "audio", title, smart: 0, uri },
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return playlistIdFrom(data);
}

async function replacePlaylist(
  baseUrl: string,
  headers: Record<string, string>,
  playlistId: string,
  title: string,
  uri: string,
) {
  const existing = await axios.get(`${baseUrl}/playlists/${encodeURIComponent(playlistId)}`, {
    headers,
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status === 200 || status === 404,
  });
  if (existing.status === 404) return false;
  await axios.put(`${baseUrl}/playlists/${encodeURIComponent(playlistId)}`, null, {
    params: { title },
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  await axios.delete(`${baseUrl}/playlists/${encodeURIComponent(playlistId)}/items`, {
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  await axios.put(`${baseUrl}/playlists/${encodeURIComponent(playlistId)}/items`, null, {
    params: { uri },
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return true;
}

export async function syncPlaylistToPlex({
  userId,
  name,
  tracks,
  previous,
}: {
  userId: number;
  name: string;
  tracks: PlaylistTrackInput[];
  previous?: PlexPlaylistSyncState | null;
}) {
  const connection = getHistoryServerConnection(userId, "plex");
  if (!connection) {
    throw new PlexPlaylistSyncError(
      "Connect Plex in Settings → Listening before syncing a playlist.",
    );
  }
  if (!tracks.length)
    throw new PlexPlaylistSyncError("Add at least one track before syncing to Plex.");

  const baseUrl = connection.url.replace(/\/+$/, "");
  const headers = plexHeaders(connection.secret, connection.clientId);
  const { data: identityData } = await axios.get(`${baseUrl}/identity`, {
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const machineIdentifier = readOne(identitySchema, identityData, {
    service: "Plex",
    endpoint: "/identity",
  }).MediaContainer.machineIdentifier;
  await assertMusicLibrary(baseUrl, headers);

  const matches = await mapWithConcurrency(tracks, SEARCH_CONCURRENCY, (track) =>
    matchTrack(baseUrl, headers, track),
  );
  const ratingKeys = matches.flatMap((match) => (match ? [match.ratingKey] : []));
  if (!ratingKeys.length) {
    throw new PlexPlaylistSyncError(
      "Plex could not find any of these tracks in its music libraries. Make sure Plex has finished scanning the folders containing this music, then try again.",
    );
  }

  const uri = `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(",")}`;
  let playlistId =
    previous?.machineIdentifier === machineIdentifier ? String(previous.playlistId || "") : "";
  let created = !playlistId;
  try {
    if (playlistId) {
      const replaced = await replacePlaylist(baseUrl, headers, playlistId, name, uri);
      if (!replaced) {
        playlistId = "";
        created = true;
      }
    }
    if (!playlistId) playlistId = await createPlaylist(baseUrl, headers, name, uri);
  } catch (error) {
    const failure = asAppError(error);
    const status = Number(failure?.response?.status);
    if (status === 401 || status === 403) {
      throw new PlexPlaylistSyncError("Plex rejected the saved connection. Sign in again.", 400);
    }
    throw error;
  }

  const matchedTracks = ratingKeys.length;
  const skippedTracks = tracks.length - matchedTracks;
  const state: PlexPlaylistSyncState = {
    machineIdentifier,
    playlistId,
    autoSync: previous?.autoSync === true,
    contentFingerprint: plexPlaylistContentFingerprint(name, tracks),
    lastSyncedAt: Date.now(),
    matchedTracks,
    skippedTracks,
    lastSyncError: null,
  };
  return { created, matchedTracks, skippedTracks, totalTracks: tracks.length, state };
}

const autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function queuePlexPlaylistAutoSync(playlistId: string, delayMs = 1_000) {
  const existing = autoSyncTimers.get(playlistId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    autoSyncTimers.delete(playlistId);
    void runPlexPlaylistAutoSync(playlistId);
  }, delayMs);
  timer.unref?.();
  autoSyncTimers.set(playlistId, timer);
}

export async function runPlexPlaylistAutoSync(playlistId: string) {
  const { flowPlaylistConfig } = await import("./playlists/flowPlaylistConfig.ts");
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist?.plexSync?.autoSync || playlist.ownerUserId == null || !playlist.tracks.length) {
    return null;
  }
  const fingerprint = plexPlaylistContentFingerprint(playlist.name, playlist.tracks);
  if (playlist.plexSync.contentFingerprint === fingerprint) return null;

  try {
    const result = await syncPlaylistToPlex({
      userId: playlist.ownerUserId,
      name: playlist.name,
      tracks: playlist.tracks,
      previous: playlist.plexSync,
    });
    flowPlaylistConfig.updateStaticPlaylist(playlist.id, { plexSync: result.state });
    return result;
  } catch (error) {
    const failure = asAppError(error);
    flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
      plexSync: {
        ...playlist.plexSync,
        lastSyncError: failure?.message || "Plex sync failed",
      },
    });
    return null;
  }
}
