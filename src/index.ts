import { Command } from 'commander';
import dotenv from 'dotenv';
import { startArtist, finishArtist } from './sheets.ts';
import { createPlaylistForArtist } from './spotify.ts';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('music-rotation')
  .description('Automate music listening workflow with Google Sheets and Spotify')
  .version('1.0.0');

program
  .command('start')
  .description('Start listening to a new random artist from the intake queue')
  .action(async () => {
    try {
      console.log('Fetching a random artist from Google Sheets...');
      const artist = await startArtist();
      if (!artist) {
        console.log('No artists left in the intake queue!');
        return;
      }
      console.log(`Selected: ${artist.name} (${artist.genre || 'No genre'})`);
      console.log(`Moved ${artist.name} to wip/done with today's start date.`);

      console.log(`Generating chronological Spotify playlist for ${artist.name}...`);
      const playlistUrl = await createPlaylistForArtist(artist.name);
      console.log(`Success! Playlist created: ${playlistUrl}`);
    } catch (error) {
      console.error('Error starting artist:', error);
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
      } else {
        console.log('No unfinished artists found in wip/done.');
      }
    } catch (error) {
      console.error('Error finishing artist:', error);
    }
  });

program.parse();
