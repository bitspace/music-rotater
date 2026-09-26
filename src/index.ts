import { Command } from 'commander';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  startArtist,
  finishArtist,
  addArtistToIntake,
  getCurrentArtist,
  setCurrentArtistPlaylist,
  type WipArtist,
} from './sheets.ts';
import {
  createPlaylistForArtist,
  playPlaylist,
  pausePlayback,
  resumePlayback,
  nextTrack,
  previousTrack,
  getNowPlaying,
  getDevices,
  getPlaylistTracks,
  findPlaylistForArtist,
  retirePlaylist,
} from './spotify.ts';
import { loadRotationState, saveRotationState, clearRotationState } from './state.ts';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('music-rotation')
  .description('Automate music listening workflow with Google Sheets and Spotify')
  .version('1.0.0');

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Shared flow: pick a random artist, move it to wip/done, build its playlist, link it. */
async function startFlow(options: { rebuild?: boolean } = {}): Promise<{ name: string; url: string; uri: string } | null> {
  console.log('Fetching a random artist from Google Sheets...');
  const artist = await startArtist();
  if (!artist) {
    console.log('No artists left in the intake queue!');
    return null;
  }
  console.log(`Selected: ${artist.name} (${artist.genre || 'No genre'})`);
  console.log(`Moved ${artist.name} to wip/done with today's start date.`);

  // Reuse the existing chronological playlist when there is one — otherwise
  // every start silently mints a duplicate playlist in the user's library.
  // --rebuild forces a fresh build and retires the old playlist.
  const existing = await findPlaylistForArtist(artist.name);
  let url: string;
  let uri: string;
  if (existing && !options.rebuild) {
    ({ url, uri } = existing);
    console.log(`Reusing existing playlist: ${url}`);
  } else {
    if (existing) {
      console.log(`Rebuilding playlist for ${artist.name} (the old one will be retired)...`);
    } else {
      console.log(`Generating chronological Spotify playlist for ${artist.name}...`);
    }
    ({ url, uri } = await createPlaylistForArtist(artist.name));
    console.log(`Success! Playlist created: ${url}`);
  }
  await setCurrentArtistPlaylist(uri, url);
  console.log('Playlist linked in the wip/done Notes column.');
  if (existing && options.rebuild) {
    // Retire the old playlist only after the new one is built AND linked in
    // the sheet — a failure anywhere above must never strand the artist with
    // no working playlist.
    await retirePlaylist(existing.uri);
    console.log(`Retired old playlist: ${existing.url}`);
  }
  clearRotationState();
  return { name: artist.name, url, uri };
}

/**
 * Resolve the current artist's playlist URI, backfilling the sheet link from
 * the user's Spotify library when the row predates playlist linking.
 */
async function ensurePlaylistUri(current: WipArtist): Promise<string> {
  if (current.playlistUri) {
    return current.playlistUri;
  }
  console.log('No playlist linked in the sheet — looking for it in your Spotify library...');
  const found = await findPlaylistForArtist(current.name);
  if (!found) {
    throw new Error(
      `No playlist found for "${current.name}" (looked for "${current.name} - Chronological"). ` +
        'Run "npm run start" to generate one.',
    );
  }
  await setCurrentArtistPlaylist(found.uri, found.url);
  console.log(`Linked existing playlist: ${found.url}`);
  return found.uri;
}

function notify(title: string, message: string): void {
  if (process.platform !== 'darwin') {
    return;
  }
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const scriptPath = path.join(os.tmpdir(), `music-rotater-notify-${Date.now()}.scpt`);
  try {
    fs.writeFileSync(scriptPath, `display notification "${esc(message)}" with title "${esc(title)}"`);
    execSync(`osascript ${JSON.stringify(scriptPath)}`, { stdio: 'ignore' });
  } catch {
    // Notifications are best-effort; the console message is the real output.
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Already gone or never written — nothing to clean up.
    }
  }
}

/**
 * True when the final track of the playlist was actually played through —
 * not merely paused. A manual pause mid-track must not count as "finished".
 */
function finalTrackPlayedThrough(progressMs: number, durationMs: number): boolean {
  if (durationMs <= 0) {
    return false;
  }
  return progressMs >= durationMs - 10_000;
}

program
  .command('start')
  .description('Start listening to a new random artist from the intake queue')
  .option('--rebuild', 'build a fresh playlist even if one already exists (retires the old one)')
  .action(async (options: { rebuild?: boolean }) => {
    try {
      await startFlow(options);
    } catch (error) {
      console.error('Error starting artist:', error);
      process.exitCode = 1;
    }
  });

program
  .command('finish')
  .description('Finish listening to the current artist and log the end date')
  .action(async () => {
    try {
      console.log('Updating end date in Google Sheets...');
      const artistName = await finishArtist();
      if (artistName) {
        console.log(`Successfully logged end date for: ${artistName}`);
        clearRotationState();
      } else {
        console.log('No unfinished artists found in wip/done.');
      }
    } catch (error) {
      console.error('Error finishing artist:', error);
      process.exitCode = 1;
    }
  });

program
  .command('new <artistName> <artistGenre>')
  .description(
    'Add a new artist to the intake queue in alphabetical order (skips if already on intake or wip/done)',
  )
  .action(async (artistName: string, artistGenre: string) => {
    try {
      console.log(`Checking workbook for ${artistName}, then adding to intake if new...`);
      const artist = await addArtistToIntake(artistName, artistGenre);
      console.log(`Added ${artist.name} (${artist.genre || 'No genre'}) to intake in alphabetical order.`);
    } catch (error) {
      console.error('Error adding artist to intake:', error);
      process.exitCode = 1;
    }
  });

program
  .command('play')
  .description("Start playback of the current artist's chronological playlist")
  .option('-d, --device <id>', 'Spotify device id (defaults to the active device)')
  .action(async (options: { device?: string }) => {
    try {
      const current = await getCurrentArtist();
      if (!current) {
        console.log('No unfinished artist in wip/done. Run "npm run start" first.');
        return;
      }
      const uri = await ensurePlaylistUri(current);
      const device = await playPlaylist(uri, options.device);
      console.log(`Playing ${current.name} on ${device.name}.`);
    } catch (error) {
      console.error('Error starting playback:', error);
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description("Show where you are in the current artist's playlist")
  .action(async () => {
    try {
      const current = await getCurrentArtist();
      if (!current) {
        console.log('No unfinished artist in wip/done.');
        return;
      }
      const uri = await ensurePlaylistUri(current);
      const tracks = await getPlaylistTracks(uri);
      const np = await getNowPlaying();

      console.log(`${current.name} — ${tracks.length} tracks in playlist (started ${current.startDate})`);

      if (np && np.contextUri === uri && np.trackUri) {
        const idx = tracks.findIndex((t) => t.uri === np.trackUri);
        const position = idx >= 0 ? `track ${idx + 1} of ${tracks.length}` : 'track position unknown';
        const state = np.isPlaying ? 'playing' : 'paused';
        console.log(
          `${position}: "${np.trackName}" — ${np.artists} ` +
            `(${formatMs(np.progressMs)} / ${formatMs(np.durationMs)}, ${state} on ${np.deviceName})`,
        );
      } else if (np) {
        console.log(
          `Not playing the rotation playlist right now — currently ${np.isPlaying ? 'playing' : 'paused'}: ` +
            `"${np.trackName}" — ${np.artists} on ${np.deviceName}.`,
        );
      } else {
        console.log('Nothing is playing right now.');
      }
    } catch (error) {
      console.error('Error getting status:', error);
      process.exitCode = 1;
    }
  });

program
  .command('devices')
  .description('List available Spotify Connect devices')
  .action(async () => {
    try {
      const devices = await getDevices();
      if (devices.length === 0) {
        console.log('No Spotify devices found. Open Spotify on your phone or computer first.');
        return;
      }
      for (const d of devices) {
        console.log(`${d.isActive ? '* ' : '  '}${d.name} (${d.type}) — ${d.id}`);
      }
    } catch (error) {
      console.error('Error listing devices:', error);
      process.exitCode = 1;
    }
  });

function deviceOption(cmd: Command): Command {
  return cmd.option('-d, --device <id>', 'Spotify device id (defaults to the active device)');
}

deviceOption(program.command('next').description('Skip to the next track')).action(
  async (options: { device?: string }) => {
    try {
      const device = await nextTrack(options.device);
      const np = await getNowPlaying();
      console.log(
        np
          ? `Skipped on ${device.name} — now: "${np.trackName}" — ${np.artists}.`
          : `Skipped on ${device.name}.`,
      );
    } catch (error) {
      console.error('Error skipping track:', error);
      process.exitCode = 1;
    }
  },
);

deviceOption(program.command('prev').description('Go back to the previous track')).action(
  async (options: { device?: string }) => {
    try {
      const device = await previousTrack(options.device);
      const np = await getNowPlaying();
      console.log(
        np
          ? `Went back on ${device.name} — now: "${np.trackName}" — ${np.artists}.`
          : `Went back on ${device.name}.`,
      );
    } catch (error) {
      console.error('Error going to previous track:', error);
      process.exitCode = 1;
    }
  },
);

deviceOption(program.command('pause').description('Pause playback')).action(
  async (options: { device?: string }) => {
    try {
      const device = await pausePlayback(options.device);
      console.log(`Paused on ${device.name}.`);
    } catch (error) {
      console.error('Error pausing:', error);
      process.exitCode = 1;
    }
  },
);

deviceOption(program.command('resume').description('Resume playback')).action(
  async (options: { device?: string }) => {
    try {
      const device = await resumePlayback(options.device);
      console.log(`Resumed on ${device.name}.`);
    } catch (error) {
      console.error('Error resuming:', error);
      process.exitCode = 1;
    }
  },
);

program
  .command('rollover')
  .description('Finish the current artist and immediately start the next one')
  .option('--rebuild', 'build a fresh playlist for the next artist even if one already exists (retires the old one)')
  .action(async (options: { rebuild?: boolean }) => {
    try {
      const done = await finishArtist();
      if (done) {
        console.log(`Finished ${done}.`);
      } else {
        console.log('No unfinished artist to finish — just starting the next one.');
      }
      clearRotationState();
      await startFlow(options);
    } catch (error) {
      console.error('Error during rollover:', error);
      process.exitCode = 1;
    }
  });

program
  .command('watch')
  .description(
    'Check whether the current rotation playlist is finished (meant to run on a schedule); ' +
      'sends a macOS notification when it is',
  )
  .action(async () => {
    try {
      const current = await getCurrentArtist();
      if (!current) {
        console.log('No active rotation — nothing to watch.');
        return;
      }
      const uri = await ensurePlaylistUri(current);
      const tracks = await getPlaylistTracks(uri);
      if (tracks.length === 0) {
        console.log('Playlist is empty — nothing to watch.');
        return;
      }
      const lastIndex = tracks.length - 1;

      const np = await getNowPlaying();
      const state = loadRotationState();
      let finished = false;

      if (np && np.contextUri === uri && np.trackUri) {
        const idx = tracks.findIndex((t) => t.uri === np.trackUri);
        const playedThrough =
          idx === lastIndex && finalTrackPlayedThrough(np.progressMs, np.durationMs);
        saveRotationState({
          playlistUri: uri,
          lastTrackUri: np.trackUri,
          lastTrackIndex: idx,
          lastProgressMs: np.progressMs,
          lastDurationMs: np.durationMs,
          reportedFinishedFor: state?.reportedFinishedFor ?? null,
          updatedAt: new Date().toISOString(),
        });
        // Final track played through to (near) the end and stopped: the playlist ran dry.
        // A manual pause mid-track does not count — see finalTrackPlayedThrough.
        if (playedThrough && !np.isPlaying) {
          finished = true;
        } else {
          const position = idx >= 0 ? `track ${idx + 1} of ${tracks.length}` : 'an untracked position';
          console.log(
            `Watching ${current.name}: ${position} ("${np.trackName}", ${np.isPlaying ? 'playing' : 'paused'}).`,
          );
        }
      } else if (
        (!np || !np.isPlaying) &&
        state &&
        state.playlistUri === uri &&
        state.lastTrackIndex === lastIndex &&
        finalTrackPlayedThrough(state.lastProgressMs ?? 0, state.lastDurationMs ?? 0)
      ) {
        // Playback stopped entirely since we last saw the final track play through.
        finished = true;
      } else if (np && np.contextUri !== uri) {
        console.log(
          `Watching ${current.name}: currently listening to something else ("${np.trackName}" — ${np.artists}).`,
        );
      } else {
        console.log(`Watching ${current.name}: nothing playing right now.`);
      }

      if (finished && state?.reportedFinishedFor !== uri) {
        const message =
          `You finished ${current.name} — all ${tracks.length} tracks. ` +
          'Run "npm run rollover" to close it out and roll the next artist.';
        console.log(message);
        notify('Music rotation', message);
        saveRotationState({
          playlistUri: uri,
          lastTrackUri: state?.lastTrackUri ?? null,
          lastTrackIndex: state?.lastTrackIndex ?? -1,
          lastProgressMs: state?.lastProgressMs ?? 0,
          lastDurationMs: state?.lastDurationMs ?? 0,
          reportedFinishedFor: uri,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Error watching rotation:', error);
      process.exitCode = 1;
    }
  });

program.parse();
