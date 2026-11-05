// Simulated time is whole minutes since Day 1 00:00.
export const HOUR = 60;
export const DAY = 24 * HOUR;

export const at = (day, hour = 0, minute = 0) => (day - 1) * DAY + hour * HOUR + minute;

export function formatTime(t) {
  const day = Math.floor(t / DAY) + 1;
  const minutes = t - (day - 1) * DAY;
  const hh = String(Math.floor(minutes / HOUR)).padStart(2, '0');
  const mm = String(minutes % HOUR).padStart(2, '0');
  return `Day ${day} ${hh}:${mm}`;
}
