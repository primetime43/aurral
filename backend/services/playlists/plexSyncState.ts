import { createHash } from "node:crypto";
import type { PlaylistTrackInput } from "./playlistTracks.ts";

export type PlexPlaylistSyncState = {
  machineIdentifier: string;
  playlistId: string;
  autoSync: boolean;
  contentFingerprint: string | null;
  lastSyncedAt: number | null;
  matchedTracks: number;
  skippedTracks: number;
  lastSyncError: string | null;
};

const text = (value: unknown) => String(value || "").trim();

export function normalizePlexPlaylistSyncState(value: unknown): PlexPlaylistSyncState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  const machineIdentifier = text(stored.machineIdentifier);
  const playlistId = text(stored.playlistId);
  if (!machineIdentifier || !playlistId) return null;
  const lastSyncedAt = Number(stored.lastSyncedAt);
  return {
    machineIdentifier,
    playlistId,
    autoSync: stored.autoSync === true,
    contentFingerprint: text(stored.contentFingerprint) || null,
    lastSyncedAt: Number.isFinite(lastSyncedAt) && lastSyncedAt > 0 ? lastSyncedAt : null,
    matchedTracks: Math.max(0, Number(stored.matchedTracks) || 0),
    skippedTracks: Math.max(0, Number(stored.skippedTracks) || 0),
    lastSyncError: text(stored.lastSyncError) || null,
  };
}

export function plexPlaylistContentFingerprint(name: unknown, tracks: PlaylistTrackInput[]) {
  const content = {
    name: text(name),
    tracks: tracks.map((track) => ({
      artistName: text(track.artistName),
      artistAliases: Array.isArray(track.artistAliases)
        ? track.artistAliases.map(text).filter(Boolean)
        : [],
      trackName: text(track.trackName),
      albumName: text(track.albumName),
      trackMbid: text(track.trackMbid),
      durationMs: Number(track.durationMs) || null,
      membershipId: text(track.membershipId),
    })),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
