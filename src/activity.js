// Tracks when a signed-in member last used the dashboard, so Helius credits are only spent while someone is on the site.
// Kept in memory, and saved to the volume (at most every 30 s) so a redeploy does not make the site look idle and park the webhooks.
import { readState, writeState } from './state.js';

let last = Number(readState('activity').last) || 0, saved = last;
export const touch = () => {
  last = Date.now();
  if (last - saved > 30_000) { saved = last; try { writeState('activity', { last }); } catch { /* the volume is not essential */ } }
};
export const idleMinutes = () => (Date.now() - last) / 60000;
export const isActive = (windowMin = +process.env.ACTIVE_WINDOW_MIN || 20) => idleMinutes() < windowMin;
