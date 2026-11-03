import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { useAuth } from "../../../../contexts/AuthContext";
import { useToast } from "../../../../contexts/ToastContext";
import { queryKeys } from "../../../../queryClient.ts";
import { historyServersClient } from "../../../../utils/api/clients/historyServers.ts";
import { formatDateTime } from "../../../../utils/dateTime.ts";
import { SettingsInput } from "../../components/SettingsField";
import { Select } from "../../../../components/Select";
import { readApiError } from "../../utils/apiError.ts";
import { ConfirmModal } from "../../../../components/ConfirmModal.tsx";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  type ServiceStatus,
} from "../../SettingsLayout";

export const HISTORY_SERVERS = ["navidrome", "plex", "jellyfin"] as const;
export type HistoryServerProvider = (typeof HISTORY_SERVERS)[number];
type HistoryServer = InferResponseType<typeof historyServersClient.$get, 200>["servers"][number];
type PlexOAuthServer = {
  id: string;
  name: string;
  connections: { uri: string; local: boolean; relay: boolean }[];
};

type PlexOAuthState = {
  transactionId: string;
  authUrl: string;
  servers: PlexOAuthServer[];
  selectedServerId: string;
  selectedUrl: string;
};

const FIELDS: Record<
  HistoryServerProvider,
  { label: string; url: string; username: string; secret: string; help: string }
> = {
  navidrome: {
    label: "Navidrome",
    url: "http://navidrome:4533",
    username: "Username",
    secret: "Password",
    help: "Imports the plays Navidrome records for this user.",
  },
  plex: {
    label: "Plex",
    url: "http://plex:32400",
    username: "Plex account",
    secret: "Server owner token",
    help: "Connect once to import listening history and sync Aurral playlists to Plex.",
  },
  jellyfin: {
    label: "Jellyfin",
    url: "http://jellyfin:8096",
    username: "Username",
    secret: "API key",
    help: "Needs the Playback Reporting plugin. Create the API key in Dashboard, API Keys.",
  },
};

export const historyServerLabel = (provider: HistoryServerProvider) => FIELDS[provider].label;

export function useHistoryServers() {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.historyServers(user?.id),
    queryFn: ({ signal }) => parseResponse(historyServersClient.$get({}, { init: { signal } })),
    refetchInterval: ({ state }) =>
      state.data?.servers.some((server) => !server.lastSyncedAt) ? 2000 : false,
  });
}

export function historyServerStatus(
  provider: HistoryServerProvider,
  server: HistoryServer | undefined,
): ServiceStatus {
  if (!server) return { label: "Not set up", tone: "muted" };
  if (server.lastError) return { label: "Sync failed", tone: "error" };
  if (provider === "plex" && server.plexMusicLibrary === false) {
    return { label: "Music library required", tone: "error" };
  }
  return { label: provider === "plex" ? "History + playlists" : "History" };
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const preferredConnection = (server: PlexOAuthServer | undefined) =>
  server?.connections.find((connection) => connection.local && !connection.relay)?.uri ||
  server?.connections.find((connection) => !connection.relay)?.uri ||
  server?.connections[0]?.uri ||
  "";

function plexConnectionLabel(connection: PlexOAuthServer["connections"][number]) {
  const kind = connection.relay ? "Relay" : connection.local ? "Local" : "Remote";
  return `${kind} · ${connection.uri}`;
}

function PlexOAuthConnect({
  connected,
  disabled,
  onConnected,
}: {
  connected: boolean;
  disabled: boolean;
  onConnected: () => Promise<unknown>;
}) {
  const { showSuccess, showError } = useToast();
  const attemptRef = useRef(0);
  const [state, setState] = useState<PlexOAuthState | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(
    () => () => {
      attemptRef.current += 1;
    },
    [],
  );

  const cancel = () => {
    attemptRef.current += 1;
    setWaiting(false);
    setState(null);
  };

  const signIn = async () => {
    const attempt = ++attemptRef.current;
    setWaiting(true);
    setState(null);
    const popup = window.open("", "aurral-plex-sign-in", "popup,width=700,height=760");
    try {
      const started = await parseResponse(historyServersClient.plex.oauth.start.$post());
      if (attempt !== attemptRef.current) {
        if (popup && !popup.closed) popup.close();
        return;
      }
      if (popup) popup.location.href = started.authUrl;
      const pendingState: PlexOAuthState = {
        transactionId: started.transactionId,
        authUrl: started.authUrl,
        servers: [],
        selectedServerId: "",
        selectedUrl: "",
      };
      setState(pendingState);
      const deadline = Date.now() + 3 * 60 * 1000;
      while (attempt === attemptRef.current && Date.now() < deadline) {
        await pause(1000);
        if (attempt !== attemptRef.current) break;
        const result = await parseResponse(
          historyServersClient.plex.oauth.complete.$post({
            json: { transactionId: started.transactionId },
          }),
        );
        if (result.pending) continue;
        const servers = result.servers || [];
        const selected = servers[0];
        setState({
          ...pendingState,
          servers,
          selectedServerId: selected?.id || "",
          selectedUrl: preferredConnection(selected),
        });
        if (popup && !popup.closed) popup.close();
        setWaiting(false);
        return;
      }
      if (popup && !popup.closed) popup.close();
      if (attempt === attemptRef.current) {
        setWaiting(false);
        showError("Plex sign-in timed out. Try again.");
      }
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      if (attempt !== attemptRef.current) return;
      setWaiting(false);
      const failure = readApiError(error);
      showError(failure.error || failure.message || failure.text || "Couldn't sign in to Plex");
    }
  };

  const chooseServer = (serverId: string) => {
    setState((current) => {
      if (!current) return current;
      const server = current.servers.find((candidate) => candidate.id === serverId);
      return {
        ...current,
        selectedServerId: serverId,
        selectedUrl: preferredConnection(server),
      };
    });
  };

  const connect = async () => {
    if (!state?.selectedServerId || !state.selectedUrl) return;
    setConnecting(true);
    try {
      await parseResponse(
        historyServersClient.plex.oauth.connect.$post({
          json: {
            transactionId: state.transactionId,
            serverId: state.selectedServerId,
            url: state.selectedUrl,
          },
        }),
      );
      setState(null);
      await onConnected();
      showSuccess("Plex connected. Importing plays.");
    } catch (error) {
      const failure = readApiError(error);
      showError(failure.error || failure.message || failure.text || "Couldn't connect Plex");
    } finally {
      setConnecting(false);
    }
  };

  const selectedServer = state?.servers.find((server) => server.id === state.selectedServerId);

  return (
    <>
      <SettingsActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || waiting || connecting}
          onClick={() => void signIn()}
        >
          {waiting ? "Waiting for Plex…" : connected ? "Sign in again" : "Sign in with Plex"}
        </button>
        {waiting ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
            Cancel
          </button>
        ) : null}
      </SettingsActions>
      {waiting && state ? (
        <SettingsNote>
          Finish signing in to Plex in the new tab. If it did not open,{" "}
          <a href={state.authUrl} target="_blank" rel="noreferrer" className="settings-link">
            open Plex sign-in
          </a>
          .
        </SettingsNote>
      ) : null}
      {state?.servers.length ? (
        <>
          <SettingsRow label="Plex server" htmlFor="plex-oauth-server">
            <Select
              id="plex-oauth-server"
              value={state.selectedServerId}
              onChange={chooseServer}
              options={state.servers.map((server) => ({ value: server.id, label: server.name }))}
            />
          </SettingsRow>
          <SettingsRow label="Connection" htmlFor="plex-oauth-connection">
            <Select
              id="plex-oauth-connection"
              value={state.selectedUrl}
              onChange={(selectedUrl) =>
                setState((current) => (current ? { ...current, selectedUrl } : current))
              }
              options={(selectedServer?.connections || []).map((connection) => ({
                value: connection.uri,
                label: plexConnectionLabel(connection),
              }))}
            />
          </SettingsRow>
          <SettingsActions>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={connecting || !state.selectedServerId || !state.selectedUrl}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect server"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
              Cancel
            </button>
          </SettingsActions>
        </>
      ) : null}
      <SettingsNote>
        Or connect manually with a server URL, Plex account name, and server owner token.
      </SettingsNote>
    </>
  );
}

function PlexMusicLibrarySetup({
  server,
  canManage,
  onUpdated,
}: {
  server: HistoryServer;
  canManage: boolean;
  onUpdated: () => Promise<unknown>;
}) {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const [libraryName, setLibraryName] = useState("Aurral Music");
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const status = useQuery({
    queryKey: queryKeys.plexMusicLibrary(user?.id),
    queryFn: () => parseResponse(historyServersClient.plex.library.$get()),
    enabled: canManage,
    refetchInterval: (query) =>
      query.state.data?.libraries.some((library) => library.refreshing) ? 3000 : false,
  });
  const folderPath = draftPath ?? status.data?.suggestedPath ?? "";
  const create = useMutation({
    mutationFn: () =>
      parseResponse(
        historyServersClient.plex.library.$post({
          json: { name: libraryName, folderPath },
        }),
      ),
    onSuccess: async (result) => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.plexMusicLibrary(user?.id) });
      await onUpdated();
      showSuccess(
        result.created
          ? "Plex music library created. Plex is scanning it now."
          : "Plex already has a music library.",
      );
    },
    onError: (error) => {
      setConfirming(false);
      const failure = readApiError(error);
      showError(failure.error || failure.message || failure.text || "Couldn't create Plex library");
    },
  });

  if (!canManage) {
    return server.plexMusicLibrary === false ? (
      <SettingsGroup title="Plex music library">
        <SettingsNote tone="warning">
          Plex needs a music library before playlists can be synced. Ask an administrator to set it
          up.
        </SettingsNote>
      </SettingsGroup>
    ) : null;
  }

  const libraries = status.data?.libraries || [];
  return (
    <>
      <SettingsGroup
        title="Plex music library"
        note={libraries.length ? "Ready for playlist sync" : "Required for playlist sync"}
      >
        {status.isPending ? <SettingsNote>Checking Plex libraries…</SettingsNote> : null}
        {status.isError ? (
          <SettingsNote tone="warning">
            Aurral couldn&apos;t check the Plex libraries. Verify the connection and try again.
          </SettingsNote>
        ) : null}
        {libraries.length ? (
          libraries.map((library) => (
            <SettingsRow
              key={library.id}
              label={library.title}
              help={
                library.refreshing
                  ? "Plex is scanning this library"
                  : library.locations.join(", ") || "Music library ready"
              }
            />
          ))
        ) : status.data ? (
          <>
            <SettingsNote tone="warning">
              Plex has no music library. Create one here so Plex can index Aurral&apos;s tracks and
              receive playlists.
            </SettingsNote>
            {status.data.needsSharedMount ? (
              <SettingsNote tone="warning">
                Aurral does not have an explicitly configured shared Library folder. If Aurral and
                Plex use separate containers, mount the same host music folder into both before
                creating the library.
              </SettingsNote>
            ) : null}
            <SettingsRow label="Library name" htmlFor="plex-library-name">
              <SettingsInput
                id="plex-library-name"
                value={libraryName}
                onChange={(event) => setLibraryName(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              label="Folder in Plex"
              htmlFor="plex-library-path"
              help="Use the absolute path as the Plex server sees it. With Docker, mount the same host folder into Plex and Aurral, ideally at the same path."
            >
              <SettingsInput
                id="plex-library-path"
                value={folderPath}
                placeholder="/data/downloads/aurral"
                onChange={(event) => setDraftPath(event.target.value)}
              />
            </SettingsRow>
            <SettingsActions>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!libraryName.trim() || !folderPath.trim() || create.isPending}
                onClick={() => setConfirming(true)}
              >
                Create music library
              </button>
              <a
                className="btn btn-ghost btn-sm"
                href="https://support.plex.tv/articles/200288926-creating-libraries/"
                target="_blank"
                rel="noreferrer"
              >
                Set up manually
              </a>
            </SettingsActions>
          </>
        ) : null}
      </SettingsGroup>
      <ConfirmModal
        open={confirming}
        title="Create Plex music library?"
        body={`Aurral will create “${libraryName.trim() || "Aurral Music"}” in Plex using ${folderPath}. Plex must be able to read this folder.`}
        confirmLabel="Create library"
        busyLabel="Creating…"
        tone="primary"
        busy={create.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => create.mutate()}
      />
    </>
  );
}

export function HistoryServerDetail({ provider }: { provider: HistoryServerProvider }) {
  const { user, hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const servers = useHistoryServers();
  const server = servers.data?.servers.find((entry) => entry.provider === provider);
  const fields = FIELDS[provider];
  const canConnect = hasPermission("accessSettings");
  const [draft, setDraft] = useState<{ url?: string; username?: string; secret: string }>({
    secret: "",
  });
  const url = draft.url ?? server?.url ?? "";
  const username = draft.username ?? server?.username ?? "";
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.historyServers(user?.id) });
  const fail = (fallback: string) => (error: unknown) => {
    const failure = readApiError(error);
    showError(failure.error || failure.text || fallback);
  };
  const param = { provider };

  const connect = useMutation({
    mutationFn: () =>
      parseResponse(
        historyServersClient[":provider"].$put({
          param,
          json: { url, username, secret: draft.secret },
        }),
      ),
    onSuccess: async () => {
      setDraft({ secret: "" });
      await refresh();
      showSuccess(`${fields.label} connected. Importing plays.`);
    },
    onError: fail(`Couldn't connect ${fields.label}`),
  });
  const sync = useMutation({
    mutationFn: () => historyServersClient[":provider"].sync.$post({ param }),
    onSuccess: () => showSuccess(`Importing ${fields.label} plays.`),
    onError: fail(`Couldn't sync ${fields.label}`),
  });
  const disconnect = useMutation({
    mutationFn: () => historyServersClient[":provider"].$delete({ param }),
    onSuccess: async () => {
      setDraft({ secret: "" });
      await refresh();
      showSuccess(`${fields.label} disconnected.`);
    },
    onError: fail(`Couldn't disconnect ${fields.label}`),
  });
  const busy = connect.isPending || sync.isPending || disconnect.isPending;

  return (
    <SettingsPage title={fields.label} back="Listening">
      {servers.isError ? (
        <SettingsNote tone="warning">Couldn&apos;t load {fields.label}.</SettingsNote>
      ) : null}
      {server?.lastError ? <SettingsNote tone="warning">{server.lastError}</SettingsNote> : null}
      <SettingsGroup
        title={provider === "plex" ? "Plex connection" : "History"}
        note={
          server
            ? [
                provider === "plex" ? "Connected for listening history and playlist sync" : null,
                `${server.plays.toLocaleString()} ${server.plays === 1 ? "play" : "plays"} imported`,
                server.lastSyncedAt
                  ? `Last synced ${formatDateTime(new Date(server.lastSyncedAt))}`
                  : "Importing",
              ]
                .filter(Boolean)
                .join(". ")
            : fields.help
        }
      >
        {canConnect ? (
          <>
            {provider === "plex" ? (
              <PlexOAuthConnect
                connected={!!server}
                disabled={busy}
                onConnected={async () => {
                  setDraft({ secret: "" });
                  await refresh();
                }}
              />
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                connect.mutate();
              }}
            >
              <SettingsRow label="Server URL" htmlFor="history-server-url">
                <SettingsInput
                  id="history-server-url"
                  type="url"
                  placeholder={fields.url}
                  autoComplete="off"
                  value={url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              </SettingsRow>
              <SettingsRow label={fields.username} htmlFor="history-server-username">
                <SettingsInput
                  id="history-server-username"
                  type="text"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                />
              </SettingsRow>
              <SettingsRow label={fields.secret} htmlFor="history-server-secret">
                <SettingsInput
                  id="history-server-secret"
                  type="password"
                  autoComplete="off"
                  placeholder={server ? "••••••••••••" : undefined}
                  value={draft.secret}
                  onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                />
              </SettingsRow>
              <SettingsActions>
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={busy || !url.trim() || !username.trim() || (!server && !draft.secret)}
                >
                  {provider === "plex"
                    ? server
                      ? "Update manually"
                      : "Connect manually"
                    : server
                      ? `Update ${fields.label}`
                      : `Connect ${fields.label}`}
                </button>
                {server ? (
                  <HistoryServerActions
                    busy={busy}
                    onSync={() => sync.mutate()}
                    onDisconnect={() => disconnect.mutate()}
                    label={fields.label}
                  />
                ) : null}
              </SettingsActions>
            </form>
          </>
        ) : server ? (
          <SettingsActions>
            <HistoryServerActions
              busy={busy}
              onSync={() => sync.mutate()}
              onDisconnect={() => disconnect.mutate()}
              label={fields.label}
            />
          </SettingsActions>
        ) : (
          <SettingsNote>Only admins can connect {fields.label}.</SettingsNote>
        )}
      </SettingsGroup>
      {provider === "plex" && server ? (
        <PlexMusicLibrarySetup server={server} canManage={canConnect} onUpdated={refresh} />
      ) : null}
    </SettingsPage>
  );
}

function HistoryServerActions({
  busy,
  label,
  onSync,
  onDisconnect,
}: {
  busy: boolean;
  label: string;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onSync}>
        Sync now
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Disconnect ${label}? Aurral removes the plays it imported.`)) {
            onDisconnect();
          }
        }}
      >
        Disconnect
      </button>
    </>
  );
}
