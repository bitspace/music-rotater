# Music Rotation Automation

This project automates a music listening workflow using Google Sheets and Spotify. It allows you to maintain an "intake" list of artists in a Google Sheet, randomly select one to listen to, automatically generate a chronological Spotify playlist of their entire catalog, and track your progress in a "wip/done" tab.

This project was hammered out in a few minutes of attention with Gemini CLI. I started with the [PLAN.md](PLAN.md) file in one interactive jam/brainstorm session. I then just dropped that into a new folder, fired up a new Gemini CLI session with fresh context, and said "follow the plan". Not even the usual `GEMINI.md` or `AGENTS.md`.

## Features

- **Random Artist Selection:** Picks a random artist from your "intake" queue in Google Sheets.
- **Automated Tracking:** Moves selected artists to a "wip/done" tab and records the "Listen Start Date".
- **Chronological Playlists:** Automatically searches Spotify for the chosen artist, retrieves all of their albums and singles, sorts them by release date, and creates a private, chronological playlist on your Spotify account.
- **Completion Logging:** Easily log the "Listen End Date" for your current artist when you've finished their catalog.

## Prerequisites

Before running the project, you need to set up credentials for both Google Cloud and Spotify.

### 1. Google Cloud Setup (for Google Sheets)
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project or select an existing one.
3. Navigate to **APIs & Services > Library** and enable the **Google Sheets API**.
4. Go to **APIs & Services > Credentials**.
5. Click **Create Credentials > Service Account**.
6. After creating the account, go to its **Keys** tab, click **Add Key > Create New Key > JSON**.
7. Save the downloaded JSON file to the root directory of this project (e.g., as `credentials.json`).
8. **Crucial:** Open the JSON file, find the `client_email` address, and share your "Listen Queue" Google Sheet with that email address, giving it **Editor** permissions.

### 2. Spotify Developer Setup
1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app**.
3. Provide an App name and description.
4. Select **Web API** as the API/SDK you are planning to use.
5. Set the **Redirect URI** to: `http://127.0.0.1:8888/callback`
6. Save the app.
7. Go to the app's **Settings** to find your **Client ID** and **Client Secret**.

## Installation and Configuration

1. **Clone/Download the repository** and open the terminal in the project folder.
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure Environment Variables:**
   Copy the `.env.example` file to a new file named `.env`:
   ```bash
   cp .env.example .env
   ```
4. **Update the `.env` file:**
   - `GOOGLE_CREDENTIALS_PATH`: The path to your downloaded Google Service Account JSON file (e.g., `./credentials.json`).
   - `SPREADSHEET_ID`: The ID of your Google Sheet (found in the URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`).
   - `SPOTIFY_CLIENT_ID`: Your Spotify App Client ID.
   - `SPOTIFY_CLIENT_SECRET`: Your Spotify App Client Secret.
   - `SPOTIFY_REDIRECT_URI`: Should be `http://127.0.0.1:8888/callback` (must match exactly what you entered in the Spotify Dashboard).

## Usage

The project provides two main commands: `start` and `finish`.

### 1. Start a New Artist

```bash
npm run start
```

**What it does:**
1. **Authentication (First Run Only):** If this is your first time running the script, it will open your web browser and ask you to log in to Spotify and authorize the app. Once authorized, it saves a token locally so you don't have to log in every time.
2. **Selects an Artist:** Fetches a random artist from the `intake` tab of your Google Sheet.
3. **Updates Sheet:** Removes the artist from the `intake` tab and adds them to the `wip/done` tab with today's date in the "Listen Start Date" column.
4. **Creates Playlist:** Searches Spotify for the artist, fetches all their albums and singles, sorts them chronologically, and creates a new private playlist on your Spotify account.
5. **Output:** Prints the selected artist, confirms the sheet updates, and provides a direct link to the newly created Spotify playlist.

### 2. Finish the Current Artist

```bash
npm run finish
```

**What it does:**
1. Scans the `wip/done` tab in your Google Sheet.
2. Finds the most recently started artist that does not yet have a "Listen End Date".
3. Updates that row by adding today's date to the "Listen End Date" column.
4. **Output:** Confirms which artist was marked as finished.

## Google Sheet Structure

For the script to work correctly, your Google Sheet must have the following exact tab names and column structures:

- **Tab Name:** `intake`
  - Column A: Artist Name
  - Column B: Genre

- **Tab Name:** `wip/done`
  - Column A: Artist Name
  - Column B: Genre
  - Column C: Listen Start Date
  - Column D: Listen End Date
  - Column E: Notes
