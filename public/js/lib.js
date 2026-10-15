// Pure helpers shared by the UI. No DOM access so they can be unit tested in Node.

export const CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Accepts "abc-defg-hij", "ABCDEFGHIJ", or a full meeting URL. Returns null if invalid. */
export function parseMeetingCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  const fromUrl = s.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?(?:[?#].*)?$/);
  if (fromUrl) s = fromUrl[1];
  if (/^[a-z]{10}$/.test(s)) s = `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
  return CODE_PATTERN.test(s) ? s : null;
}

/** Column count for a Meet-like auto layout. */
export function gridColumns(count, { narrow = false } = {}) {
  if (count <= 1) return 1;
  if (narrow) return count <= 3 ? 1 : 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export function initial(name) {
  const ch = [...String(name ?? '').trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#a142f4', '#007b83', '#c5221f', '#b06000'];

/** Stable color per participant id. */
export function avatarColor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatHomeClock(date) {
  const time = formatClock(date);
  const day = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${time} • ${day}`;
}

/** Root-mean-square level of a byte time-domain buffer (128 == silence), 0..1. */
export function audioLevel(bytes) {
  if (!bytes?.length) return 0;
  let sum = 0;
  for (const b of bytes) {
    const v = (b - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}

export function peopleInCallText(count) {
  if (!count) return 'No one else is here';
  return count === 1 ? '1 other person is in this call' : `${count} other people are in this call`;
}
