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

const SCOPES = ['playlist-modify-public', 'playlist-modify-private'];

/**
 * Perform OAuth 2.0 flow to authenticate the user.
 */
async function authenticate(): Promise<void> {
  // Check if we already have saved tokens
  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
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
      };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens));
      return;
    } catch (err) {
      console.log('Saved token is invalid or expired. Re-authenticating...');
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
            fs.writeFileSync(TOKEN_PATH, JSON.stringify({ access_token, refresh_token }));

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

export async function createPlaylistForArtist(artistName: string): Promise<string> {
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
    const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
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

  return playlistUrl;
}
