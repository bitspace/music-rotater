import fs from 'fs';
import path from 'path';

/**
 * Tiny JSON state file so the `watch` command can tell "the last track of the
 * rotation playlist finished" apart from "nothing is playing right now".
 * Lives next to the token file; never committed (see .gitignore).
 */
const STATE_PATH = path.join(process.cwd(), '.rotation_state.json');

export interface RotationState {
  playlistUri: string;
  lastTrackUri: string | null;
  /** Index of the last-seen track within the playlist, or -1 when unknown. */
  lastTrackIndex: number;
  /** Playlist URI we already reported as finished (so we only ping once). */
  reportedFinishedFor: string | null;
  updatedAt: string;
}

export function loadRotationState(): RotationState | null {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as RotationState;
  } catch {
    return null;
  }
}

export function saveRotationState(state: RotationState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function clearRotationState(): void {
  try {
    if (fs.existsSync(STATE_PATH)) {
      fs.unlinkSync(STATE_PATH);
    }
  } catch {
    // best-effort
  }
}
