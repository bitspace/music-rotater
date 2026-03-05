# Listen Queue Automation Plan

## Project Overview

This project aims to automate a music listening workflow currently managed in a Google Sheet ("Listen Queue"). The current manual process involves:
1. Randomly selecting an artist from the "intake" tab.
2. Moving that artist to the "wip/done" tab and recording a start date.
3. Finding the artist on Spotify and listening to their entire catalog in chronological order.
4. Recording a completion date in the "wip/done" tab when finished.

Since the Gemini CLI Google Workspace extension only supports reading from Sheets, we will build a standalone local script to handle both reading/writing to Google Sheets and interacting with the Spotify API.

## Core Features

1.  **Start New Artist (`start` command)**
    *   Read the "intake" tab from the Google Sheet.
    *   Select a random artist.
    *   Remove the artist from the "intake" tab.
    *   Append the artist to the "wip/done" tab with the current date as the "Listen Start Date".
    *   Search Spotify for the selected artist.
    *   Fetch all of the artist's albums and singles.
    *   Sort the releases chronologically.
    *   *Action:* Either queue these releases on the user's active Spotify device or create a new chronological playlist for the user.
2.  **Finish Current Artist (`finish` command)**
    *   Find the row in the "wip/done" tab that has a "Listen Start Date" but no "Listen End Date" (or the most recent incomplete entry).
    *   Update that row with the current date as the "Listen End Date".

## Prerequisites

1.  **Google Cloud Project:**
    *   Enable the Google Sheets API.
    *   Create a Service Account (or OAuth 2.0 Client ID for desktop app) and download the credentials JSON.
    *   *Note:* If using a Service Account, share the "Listen Queue" Google Sheet with the Service Account email address with "Editor" permissions.
2.  **Spotify Developer Dashboard:**
    *   Create a new application (requires a Premium account).
    *   Obtain the `Client ID` and `Client Secret`.
    *   Set up a Redirect URI (e.g., `http://localhost:8888/callback`) for user authorization. The app will need scopes like `playlist-modify-private`, `playlist-modify-public`, `user-modify-playback-state` (if queuing directly), and `user-read-playback-state`.

## Technology Stack Recommendation

*   **Language:** Python or Node.js/TypeScript (both have excellent libraries for these APIs).
*   **Google Sheets:**
    *   Python: `gspread` and `google-auth`
    *   Node.js: `googleapis` (specifically the Sheets v4 API)
*   **Spotify:**
    *   Python: `spotipy`
    *   Node.js: `spotify-web-api-node`
*   **Configuration:** `.env` file for storing API credentials and the Spreadsheet ID (`1ADQleQ3gO5XAlRqab9Nu2ydmCKf1rvh9uwqN2Sbt-1w`).

## Implementation Steps for Agents

### Phase 1: Setup and Configuration
1.  Initialize the project (e.g., `npm init -y` or `poetry init`/`pipenv`).
2.  Install required dependencies (Google API client, Spotify API client, dotenv).
3.  Set up environment variables handling for credentials.

### Phase 2: Google Sheets Integration
1.  Implement authentication using the downloaded Google credentials.
2.  Create a function to fetch all rows from the "intake" tab.
3.  Create a function to delete a specific row from the "intake" tab.
4.  Create a function to append a new row to the "wip/done" tab.
5.  Create a function to find and update an existing row in the "wip/done" tab (for the `finish` command).

### Phase 3: Spotify Integration
1.  Implement OAuth authorization code flow for Spotify (required to modify user playback or playlists).
2.  Create a function to search for an artist by name and retrieve their Spotify ID.
3.  Create a function to fetch all albums/singles for an artist ID.
4.  Implement sorting logic to order releases chronologically by release date.
5.  Create a function to either:
    *   Create a new playlist and add all tracks from the sorted releases.
    *   Queue the tracks directly to the user's active device (requires active playback).

### Phase 4: CLI Interface
1.  Build a simple command-line interface (using libraries like `argparse` in Python or `commander` in Node.js) to expose the `start` and `finish` workflows.
    *   `start`: Triggers the full selection, sheet update, and Spotify generation flow.
    *   `finish`: Triggers the sheet update flow to log the end date.

## Edge Cases to Handle
*   Artist not found on Spotify.
*   Multiple artists with the same name on Spotify (might need fuzzy matching or user confirmation if ambiguous).
*   Spotify API rate limits (implement backoff/retries).
*   No active Spotify device found (if choosing the queueing method instead of playlist creation).
*   "intake" sheet is empty.
