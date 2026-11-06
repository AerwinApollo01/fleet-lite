// The demo fleet size survives a reload. Browser storage can be unavailable, so it's only a convenience.
const KEY = 'fleet-lite:fleet-size';
export const SIZES = [60, 1000, 5000];

export function savedFleetSize() {
  try {
    const size = Number(window.localStorage.getItem(KEY));
    return SIZES.includes(size) ? size : SIZES[0];
  } catch {
    return SIZES[0];
  }
}

export function saveFleetSize(size) {
  try {
    window.localStorage.setItem(KEY, String(size));
  } catch {
    // The size just won't survive a reload.
  }
}
