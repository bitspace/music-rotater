import SpotifyWebApi from 'spotify-web-api-node';
import dotenv from 'dotenv';
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';

dotenv.config();

const TOKEN_PATH = path.join(process.cwd(), '.spotify_token.json');

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  // Reading the user's (private) playlists: findPlaylistForArtist backfill,
  // getPlaylistTracks on the private chronological playlists.
  'playlist-read-private',
  // Playback control (play/status/next/pause/watch commands)
  'user-read-playback-state',
  'user-modify-playback-state',
];

/**
 * Perform OAuth 2.0 flow to authenticate the user.
 */
async function authenticate(): Promise<void> {
  // Check if we already have saved tokens
  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    const savedScopes: string[] = Array.isArray(tokens.scopes) ? tokens.scopes : [];
    const scopesMatch =
      savedScopes.length === SCOPES.length && SCOPES.every((s) => savedScopes.includes(s));

    if (scopesMatch) {
      spotifyApi.setAccessToken(tokens.access_token);
      spotifyApi.setRefreshToken(tokens.refresh_token);

      // Try refreshing the token to see if it's still valid
      try {
        const data = await spotifyApi.refreshAccessToken();
        const access_token = data.body['access_token'];
        spotifyApi.setAccessToken(access_token);

        // Save the updated access token (and refresh token if it changed)
        const updatedTokens = {
          ...tokens,
          access_token: access_token,
          refresh_token: data.body['refresh_token'] || tokens.refresh_token,
          scopes: SCOPES,
        };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens));
        return;
      } catch (err) {
        console.log('Saved token is invalid or expired. Re-authenticating...');
      }
    } else {
      console.log('Spotify permissions changed — re-authenticating to pick up new scopes...');
    }
  }

  // If no saved token, start the local server for OAuth flow
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = url.parse(req.url!, true);
        
        if (reqUrl.pathname === '/callback') {
          const code = reqUrl.query.code as string;
          if (code) {
            const data = await spotifyApi.authorizationCodeGrant(code);
            const { access_token, refresh_token } = data.body;
            
            spotifyApi.setAccessToken(access_token);
            spotifyApi.setRefreshToken(refresh_token);

            // Save tokens for future runs
            fs.writeFileSync(
              TOKEN_PATH,
              JSON.stringify({ access_token, refresh_token, scopes: SCOPES }),
            );

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication successful!</h1><p>You can close this tab and return to the terminal.</p>');
            server.close();
            resolve();
          } else {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Authentication failed. No code provided.');
            server.close();
            reject(new Error('No code provided'));
          }
        }
      } catch (err) {
        console.error('Error during authentication callback', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Authentication failed.');
        server.close();
        reject(err);
      }
    });

    server.listen(8888, '127.0.0.1', async () => {
      const authorizeURL = spotifyApi.createAuthorizeURL(SCOPES, 'state');
      console.log('Please open this URL in your browser to log in to Spotify:');
      console.log(authorizeURL);
      
      // Attempt to automatically open the browser
      try {
        const open = (await (import('open'))).default;
        await open(authorizeURL);
      } catch (err) {
        // If 'open' fails, the user can still click the URL
      }
    });
  });
}

export interface GeneratedPlaylist {
  url: string;
  uri: string;
}

export async function createPlaylistForArtist(artistName: string): Promise<GeneratedPlaylist> {
  // 1. Authenticate with Spotify
  await authenticate();

  // 2. Search for the artist
  console.log(`Searching for artist: ${artistName}`);
  const searchResults = await spotifyApi.searchArtists(artistName);
  const artist = searchResults.body.artists?.items[0];

  if (!artist) {
    throw new Error(`Artist "${artistName}" not found on Spotify.`);
  }

  const artistId = artist.id;
  console.log(`Found artist: ${artist.name} (${artist.id})`);

  // 3. Fetch all albums and singles
  let allAlbums: any[] = [];
  let offset = 0;
  let hasMore = true;

  console.log('Fetching all albums and singles...');
  while (hasMore) {
    const response = await spotifyApi.getArtistAlbums(artistId, {
      limit: 10,
      offset,
      include_groups: 'album,single',
    });
    allAlbums = allAlbums.concat(response.body.items);
    if (!response.body.next) {
      hasMore = false;
    } else {
      offset += response.body.items.length;
    }
  }

  // 4. Sort releases chronologically
  // We should also filter for unique names to avoid duplicates (e.g. same album in different regions)
  // though simple sorting is the first priority.
  const sortedAlbums = allAlbums.sort((a, b) => {
    return a.release_date.localeCompare(b.release_date);
  });

  // 5. Create a new playlist
  const me = await spotifyApi.getMe();
  const playlistName = `${artist.name} - Chronological`;
  console.log(`Creating playlist: ${playlistName}`);
  const playlistResponse = await spotifyApi.createPlaylist(playlistName, {
    description: `Chronological releases for ${artist.name}, generated by music-rotation-project.`,
    public: false,
  });
  const playlistId = playlistResponse.body.id;
  const playlistUrl = playlistResponse.body.external_urls.spotify;
  const playlistUri = playlistResponse.body.uri;

  // 6. Fetch tracks for each album and add them to the playlist
  console.log(`Fetching tracks for ${sortedAlbums.length} releases...`);
  const allTrackUris: string[] = [];

  for (const album of sortedAlbums) {
    let albumTracks: any[] = [];
    let trackOffset = 0;
    let trackLimit = 50;
    let trackHasMore = true;

    while (trackHasMore) {
      const trackResponse = await spotifyApi.getAlbumTracks(album.id, {
        limit: trackLimit,
        offset: trackOffset,
      });
      albumTracks = albumTracks.concat(trackResponse.body.items);
      if (trackResponse.body.items.length < trackLimit) {
        trackHasMore = false;
      } else {
        trackOffset += trackLimit;
      }
    }
    
    const uris = albumTracks.map(t => t.uri);
    allTrackUris.push(...uris);
  }

  // 7. Add tracks to playlist in batches of 100
  console.log(`Adding ${allTrackUris.length} tracks to the playlist...`);
  for (let i = 0; i < allTrackUris.length; i += 100) {
    const batch = allTrackUris.slice(i, i + 100);
    const response = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${spotifyApi.getAccessToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uris: batch })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add tracks: ${response.status} ${response.statusText} - ${errorText}`);
    }
  }

  return { url: playlistUrl, uri: playlistUri };
}

// ---------------------------------------------------------------------------
// Playback control
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  id: string;
  name: string;
  isActive: boolean;
  type: string;
}

export interface NowPlaying {
  isPlaying: boolean;
  trackName: string;
  artists: string;
  trackUri: string;
  progressMs: number;
  durationMs: number;
  /** Spotify context URI (playlist/album/artist) playback started from, if any. */
  contextUri: string | null;
  deviceName: string;
}

export interface PlaylistTrack {
  uri: string;
  name: string;
  artists: string;
  durationMs: number;
}

export async function getDevices(): Promise<DeviceInfo[]> {
  await authenticate();
  const res = await spotifyApi.getMyDevices();
  // Drop devices without an id — they can't be targeted by playback commands.
  return (res.body.devices ?? [])
    .filter((d) => d.id)
    .map((d) => ({
      id: d.id ?? '',
      name: d.name ?? 'unknown device',
      isActive: d.is_active ?? false,
      type: d.type ?? '',
    }));
}

/**
 * Pick a device to control: the explicit id, the active device, or the first
 * available one (Spotify will try to wake an inactive device on play).
 */
export async function resolveDevice(deviceId?: string): Promise<DeviceInfo> {
  const devices = await getDevices();
  if (deviceId) {
    const found = devices.find((d) => d.id === deviceId);
    if (!found) {
      throw new Error(`Device "${deviceId}" not found. Run "devices" to list available devices.`);
    }
    return found;
  }
  const active = devices.find((d) => d.isActive);
  if (active) {
    return active;
  }
  const first = devices[0];
  if (first) {
    return first;
  }
  throw new Error(
    'No Spotify devices found. Open Spotify on your phone or computer first, then try again.',
  );
}

export async function getNowPlaying(): Promise<NowPlaying | null> {
  await authenticate();
  let body: any;
  try {
    const res = await spotifyApi.getMyCurrentPlaybackState();
    body = res.body;
  } catch {
    return null;
  }
  if (!body || !body.item) {
    return null;
  }
  return {
    isPlaying: body.is_playing ?? false,
    trackName: body.item.name ?? 'unknown track',
    artists: (body.item.artists ?? []).map((a: any) => a.name).join(', '),
    trackUri: body.item.uri ?? '',
    progressMs: body.progress_ms ?? 0,
    durationMs: body.item.duration_ms ?? 0,
    contextUri: body.context ? (body.context.uri ?? null) : null,
    deviceName: body.device ? (body.device.name ?? 'unknown device') : 'unknown device',
  };
}

/** Start (or restart) playback of a playlist on the given device. */
export async function playPlaylist(playlistUri: string, deviceId?: string): Promise<DeviceInfo> {
  await authenticate();
  const device = await resolveDevice(deviceId);
  await spotifyApi.play({ device_id: device.id, context_uri: playlistUri });
  return device;
}

export async function pausePlayback(deviceId?: string): Promise<DeviceInfo> {
  await authenticate();
  const device = await resolveDevice(deviceId);
  await spotifyApi.pause({ device_id: device.id });
  return device;
}

export async function resumePlayback(deviceId?: string): Promise<DeviceInfo> {
  await authenticate();
  const device = await resolveDevice(deviceId);
  await spotifyApi.play({ device_id: device.id });
  return device;
}

export async function nextTrack(deviceId?: string): Promise<DeviceInfo> {
  await authenticate();
  const device = await resolveDevice(deviceId);
  await spotifyApi.skipToNext({ device_id: device.id });
  return device;
}

export async function previousTrack(deviceId?: string): Promise<DeviceInfo> {
  await authenticate();
  const device = await resolveDevice(deviceId);
  await spotifyApi.skipToPrevious({ device_id: device.id });
  return device;
}

/** All playable tracks of a playlist, in order (skips local/unavailable entries). */
export async function getPlaylistTracks(playlistUri: string): Promise<PlaylistTrack[]> {
  await authenticate();
  const playlistId = playlistUri.split(':').pop() ?? '';
  const tracks: PlaylistTrack[] = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    // NOTE: spotify-web-api-node's getPlaylistTracks() still calls the legacy
    // /playlists/{id}/tracks path, which Spotify's Feb 2026 migration turned
    // into a bare 403 for Development Mode apps. /items is the replacement;
    // entry field renamed track -> item.
    // See: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const response = await fetch(
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items?${params}`,
      { headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` } },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch playlist items: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
    const body = (await response.json()) as any;
    const items: any[] = body.items ?? [];
    for (const entry of items) {
      const t: any = entry.item ?? entry.track;
      if (!t || !t.uri) {
        continue;
      }
      tracks.push({
        uri: t.uri,
        name: t.name ?? 'unknown track',
        artists: (t.artists ?? []).map((a: any) => a.name).join(', '),
        durationMs: t.duration_ms ?? 0,
      });
    }
    if (!body.next) {
      break;
    }
    offset += items.length;
  }
  return tracks;
}

/**
 * Find this project's chronological playlist for an artist ("<name> - Chronological")
 * in the user's library. Used to backfill the sheet link for rows created
 * before playlist URIs were recorded in Notes.
 */
export async function findPlaylistForArtist(
  artistName: string,
): Promise<GeneratedPlaylist | null> {
  await authenticate();
  const wanted = `${artistName} - Chronological`.toLowerCase();
  let offset = 0;
  for (;;) {
    const res = await spotifyApi.getUserPlaylists({ limit: 50, offset });
    const items = res.body.items ?? [];
    for (const p of items) {
      if (p.name && p.name.toLowerCase() === wanted) {
        return { url: p.external_urls.spotify, uri: p.uri };
      }
    }
    if (!res.body.next) {
      break;
    }
    offset += items.length;
  }
  return null;
}

/**
 * Remove a playlist from the user's library. Takes a `spotify:playlist:<id>` URI.
 */
export async function retirePlaylist(playlistUri: string): Promise<void> {
  await authenticate();
  const match = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(playlistUri);
  const playlistId = match?.[1];
  if (!playlistId) {
    throw new Error(`Cannot parse playlist id from URI: ${playlistUri}`);
  }
  await spotifyApi.unfollowPlaylist(playlistId);
}
