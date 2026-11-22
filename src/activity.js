// Tracks when a signed-in member last used the dashboard, so Helius credits are only spent while someone is on the site.
// In memory only: after a restart the site counts as idle until the next member request.
let last = 0;
export const touch = () => { last = Date.now(); };
export const idleMinutes = () => (Date.now() - last) / 60000;
export const isActive = (windowMin = +process.env.ACTIVE_WINDOW_MIN || 20) => idleMinutes() < windowMin;
