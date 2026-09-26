---
name: "music-rotater"
description: "Drive the personal music listening rotation: check what's playing, control Spotify playback, move through the artist queue, and watch for playlist completion. Use when the user asks about their listening queue, current artist, playback control, or finishing an artist."
---

# Music Rotater

## Purpose

A personal listening-rotation system. A Google Sheet (`intake` queue, `wip/done` log)
drives Spotify: each artist gets a private "<Artist> - Chronological" playlist of their
full catalog. The CLI picks artists, builds playlists, controls playback on Spotify
Connect devices, and detects when a playlist is finished.

Run commands from the repo root as `npm run <cmd>`.

## Setup

`npm install`, then a `.env` with:

- `GOOGLE_CREDENTIALS_PATH` — service-account JSON key file (the target Google Sheet
  must be shared with its `client_email` as Editor)
- `SPREADSHEET_ID` — from the sheet URL
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback` (must match the Spotify Dashboard entry)

The first run — and any run after the scope list changes — opens a browser for one-time
Spotify OAuth. Requested scopes: `playlist-modify-public`, `playlist-modify-private`,
`playlist-read-private`, `user-read-playback-state`, `user-modify-playback-state`.
The token is cached in `.spotify_token.json`.

## Tooling

Rotation:

- `npm run status` — current artist, playlist track count, now-playing position.
  The safe first run: it never starts playback. Its only write is backfilling the
  playlist link into the Notes column when none is linked yet — and that write
  replaces the whole Notes cell, so treat the column as owned by the tool.
- `npm run start` — pick a random artist from `intake`, move them to `wip`, and build
  a new chronological playlist for them. It does not check for an existing playlist
  first — starting an artist that already has one creates a duplicate.
- `npm run rollover` — mark the current artist finished (`wip` → `done`) and start
  the next rotation.
- `npm run finish` — legacy single step: finish the current artist
  (`rollover` does finish + start).
- `npm run new "<artist>" "<genre>"` — add an artist to the `intake` queue
  (inserted alphabetically, skips duplicates).

Playback — all accept `--device "<name>"`; default is the active Spotify Connect device:

- `npm run play` — play the current rotation playlist (resumes where it left off)
- `npm run pause` / `npm run resume`
- `npm run next` / `npm run prev`
- `npm run devices` — list Spotify Connect devices

Watcher:

- `npm run watch` — check whether the current playlist is finished; prints progress and
  sends a one-time macOS notification when it is. Meant to run on a schedule
  (cron/launchd), not as a daemon. State lives in `.rotation_state.json` (gitignored).
  "Finished" means the final track actually played through — a manual pause mid-track
  does not count.

## Operating Rules

1. `status` is the safe probe: it never starts playback. Its only write is linking
   the playlist into the Notes column when none is linked yet — and that write
   replaces the whole cell, so never stash anything else in Notes.
2. `start`, `rollover`, and `finish` modify the Google Sheet and the Spotify library.
   Confirm with the user before running them unprompted.
3. Playback commands act on the user's live Spotify session — they interrupt real
   listening. Confirm first unless the user asked for the action.
4. On a Spotify 403, diagnose before re-authenticating: `Insufficient client scope`
   means the scope list changed (delete `.spotify_token.json` and re-run); a bare
   `Forbidden` on playlist reads is Spotify platform gating, not auth — the
   Feb 2026 migration renamed `GET /playlists/{id}/tracks` to `/playlists/{id}/items`
   (https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
5. `.env`, the Google credentials JSON, and `.spotify_token.json` are secrets: never
   print, log, or commit them.
