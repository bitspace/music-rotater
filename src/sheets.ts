import { google } from 'googleapis';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const spreadsheetId = process.env.SPREADSHEET_ID || '1ADQleQ3gO5XAlRqab9Nu2ydmCKf1rvh9uwqN2Sbt-1w';

// Initialize Google Sheets API client
async function getSheetsClient() {
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!credentialsPath) {
    throw new Error('GOOGLE_CREDENTIALS_PATH is not set in .env');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(credentialsPath),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

export interface Artist {
  name: string;
  genre: string;
}

/** An artist currently in progress on the wip/done tab (has a start date, no end date). */
export interface WipArtist {
  name: string;
  genre: string;
  startDate: string;
  /** Spotify playlist URI linked in the Notes column (null for rows created before linking). */
  playlistUri: string | null;
  playlistUrl: string | null;
  /** 1-based row number in the wip/done sheet (header is row 1). */
  rowNumber: number;
}

const PLAYLIST_URI_PATTERN = /spotify:playlist:[A-Za-z0-9]+/;
const PLAYLIST_URL_PATTERN = /https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+/;

function parsePlaylistFromNotes(notes: unknown): { uri: string | null; url: string | null } {
  const text = String(notes ?? '');
  const uriMatch = text.match(PLAYLIST_URI_PATTERN);
  const urlMatch = text.match(PLAYLIST_URL_PATTERN);
  return {
    uri: uriMatch ? uriMatch[0] : null,
    url: urlMatch ? urlMatch[0] : null,
  };
}

/**
 * Shared scan of wip/done rows: index of the unfinished row (has a Listen Start
 * Date but no Listen End Date, most recent start wins), or -1 when none exists.
 */
function findUnfinishedRowIndex(rows: unknown[][]): number {
  let targetRowIndex = -1;
  let latestDate = new Date(0);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    const startDateStr = row[2];
    const endDateStr = row[3];

    if (startDateStr && !endDateStr) {
      const startDate = new Date(String(startDateStr));
      // Fallback in case date parsing fails or is invalid
      if (isNaN(startDate.getTime())) {
        if (targetRowIndex === -1) targetRowIndex = i; // just take the first one we see
      } else if (startDate >= latestDate) {
        latestDate = startDate;
        targetRowIndex = i;
      }
    }
  }

  return targetRowIndex;
}
function compareArtistNames(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' });
}

function artistNamesMatch(a: unknown, b: unknown): boolean {
  return compareArtistNames(a, b) === 0;
}

function sortRowsByArtistName<T extends unknown[]>(rows: T[]): T[] {
  return rows.sort((a, b) => compareArtistNames(a[0], b[0]));
}

/**
 * Case/diacritic-insensitive scan of both workbook tabs for an existing artist name.
 * Returns the first location found, or null if the artist is absent from both sheets.
 */
function findExistingArtistLocation(
  intakeRows: unknown[][],
  wipRows: unknown[][],
  artistName: string,
): 'intake' | 'wip/done' | null {
  for (const row of intakeRows) {
    if (artistNamesMatch(row?.[0], artistName)) {
      return 'intake';
    }
  }
  for (const row of wipRows) {
    if (artistNamesMatch(row?.[0], artistName)) {
      return 'wip/done';
    }
  }
  return null;
}

export async function addArtistToIntake(name: string, genre: string): Promise<Artist> {
  const normalizedName = name.trim();
  const normalizedGenre = genre.trim();

  if (!normalizedName) {
    throw new Error('Artist name cannot be empty.');
  }

  const sheets = await getSheetsClient();

  // Dedupe across the whole workbook: refuse if the artist is already on either sheet.
  const [intakeResponse, wipResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'intake!A2:B',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'wip/done!A2:A',
    }),
  ]);

  const intakeRows = intakeResponse.data.values || [];
  const wipRows = wipResponse.data.values || [];
  const existingLocation = findExistingArtistLocation(intakeRows, wipRows, normalizedName);

  if (existingLocation) {
    throw new Error(
      `Artist "${normalizedName}" already exists in the "${existingLocation}" sheet. Not adding a duplicate.`,
    );
  }

  intakeRows.push([normalizedName, normalizedGenre]);
  sortRowsByArtistName(intakeRows);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'intake!A2:B',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'intake!A2',
    valueInputOption: 'RAW',
    requestBody: {
      values: intakeRows,
    },
  });

  return { name: normalizedName, genre: normalizedGenre };
}

export async function startArtist(): Promise<Artist | null> {
  const sheets = await getSheetsClient();

  // 1. Fetch data from "intake"
  const intakeResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'intake!A2:B', // Assuming row 1 is header
  });

  const rows = intakeResponse.data.values;
  if (!rows || rows.length === 0) {
    return null;
  }

  // 2. Pick a random row
  const randomIndex = Math.floor(Math.random() * rows.length);
  const selectedRow = rows[randomIndex];
  if (!selectedRow) {
    return null;
  }
  const name = String(selectedRow[0] ?? '');
  const genre = String(selectedRow[1] ?? '');
  
  // 3. Remove from "intake"
  // Note: Values.clear doesn't shift rows up. We have to re-upload the entire list or delete the row.
  // Using a simpler approach: read all, filter out the selected, and overwrite "intake".
  const remainingRows = rows.filter((_, index) => index !== randomIndex);
  
  // Clear the intake range first
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'intake!A2:B',
  });

  // Write back the remaining rows
  if (remainingRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'intake!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: remainingRows,
      },
    });
  }

  // 4. Insert into "wip/done" in alphabetical order
  // Columns: Artist Name, Genre, Listen Start Date, Listen End Date, Notes
  const today = new Date().toLocaleDateString();
  const newRow = [name, genre || '', today, '', ''];

  const wipResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'wip/done!A2:E',
  });

  let wipRows = wipResponse.data.values || [];
  wipRows.push(newRow);

  // Sort alphabetically by artist name (column A, index 0)
  sortRowsByArtistName(wipRows);

  // Clear existing values and overwrite with sorted array
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'wip/done!A2:E',
  });

  if (wipRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'wip/done!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: wipRows,
      },
    });
  }

  return { name, genre };
}

export async function finishArtist(): Promise<string | null> {
  const sheets = await getSheetsClient();

  // 1. Fetch data from "wip/done"
  const wipResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'wip/done!A2:E',
  });

  const rows = wipResponse.data.values;
  if (!rows || rows.length === 0) {
    return null;
  }

  // 2. Find the row with the most recent Listen Start Date that has no Listen End Date
  const targetRowIndex = findUnfinishedRowIndex(rows);

  if (targetRowIndex === -1) {
    return null;
  }

  const targetRow = rows[targetRowIndex];
  if (!targetRow) {
    return null;
  }

  const artistName = String(targetRow[0] ?? '');
  const today = new Date().toLocaleDateString();

  // 3. Update the row with today's date in column D (index 3)
  // Sheets API rows are 1-based, and we skipped header, so row starts at index 2.
  const sheetRowNumber = targetRowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `wip/done!D${sheetRowNumber}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[today]],
    },
  });

  return artistName;
}

/**
 * Return the currently in-progress artist (start date set, no end date),
 * including the playlist URI/URL parsed out of the Notes column.
 */
export async function getCurrentArtist(): Promise<WipArtist | null> {
  const sheets = await getSheetsClient();

  const wipResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'wip/done!A2:E',
  });

  const rows = wipResponse.data.values;
  if (!rows || rows.length === 0) {
    return null;
  }

  const targetRowIndex = findUnfinishedRowIndex(rows);
  if (targetRowIndex === -1) {
    return null;
  }

  const row = rows[targetRowIndex];
  if (!row) {
    return null;
  }

  const { uri, url } = parsePlaylistFromNotes(row[4]);

  return {
    name: String(row[0] ?? ''),
    genre: String(row[1] ?? ''),
    startDate: String(row[2] ?? ''),
    playlistUri: uri,
    playlistUrl: url,
    rowNumber: targetRowIndex + 2,
  };
}

/**
 * Record the generated playlist in the Notes column (E) of the current
 * in-progress artist row. This is what links a wip/done row to its Spotify
 * playlist for the play/status/watch commands.
 */
export async function setCurrentArtistPlaylist(
  playlistUri: string,
  playlistUrl: string,
): Promise<void> {
  const sheets = await getSheetsClient();
  const current = await getCurrentArtist();
  if (!current) {
    throw new Error('No unfinished artist in wip/done to link a playlist to.');
  }

  const notes = `Playlist: ${playlistUrl} (${playlistUri})`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `wip/done!E${current.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[notes]],
    },
  });
}
