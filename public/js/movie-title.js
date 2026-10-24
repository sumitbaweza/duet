// A readable name for the movie, shown to both people at the top of the player.
//
// Phone galleries (Android Photos / Gallery pickers) don't hand the browser the name you see in the
// gallery, only an internal number like "1000012345.mp4", so two different movies look the same.
// So: prefer the title stored inside the file, then a tidied file name, then (for numbered or camera
// names) "Video · <when it was recorded> · <length>".

const LIB = 'mediabunny';

/** Title stored in the file's own metadata (most downloaded movies have one), or null. */
export async function embeddedTitle(file) {
  let input = null;
  try {
    const MB = await import(LIB);
    input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const title = (await input.getMetadataTags())?.title?.trim();
    return title && !isMeaningless(title) ? title.slice(0, 120) : null;
  } catch {
    return null;
  } finally {
    input?.dispose?.();
  }
}

/** File name without its extension. */
const baseName = (name) => (name || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();

/** Names that say nothing about the movie: numbers, "video", "VID-123", "msf:123"… */
function isMeaningless(text) {
  const t = text.trim();
  return (
    !t ||
    /^[\d\s._-]+$/.test(t) ||
    /^(video|vid|movie|mov|clip|file|media|img|image|document|msf|primary)[\s:._-]*\d*$/i.test(t)
  );
}

/** Camera-style names carry the recording time: VID_20261024_201530, PXL_20261024_201530123, 20261024_201530. */
function cameraDate(base) {
  const m = base.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatWhen(d) {
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return `${date}, ${time}`;
}

function formatLength(sec) {
  if (!(sec > 0)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * @param {string} fileName
 * @param {{embedded?: string|null, lastModified?: number, duration?: number}} [info]
 */
export function movieTitle(fileName, { embedded = null, lastModified = 0, duration = 0 } = {}) {
  if (embedded && !isMeaningless(embedded)) return embedded;
  const base = baseName(fileName);
  const camera = cameraDate(base);
  if (base && !camera && !isMeaningless(base)) {
    // "Some.Movie.2024.1080p" → "Some Movie 2024 1080p"; names with spaces are kept as typed.
    return /\s/.test(base) ? base : base.replace(/[._]+/g, ' ').trim();
  }
  // A modified time within the last minute is just "when it was picked", not when it was recorded.
  const when = camera || (lastModified && Date.now() - lastModified > 60_000 ? new Date(lastModified) : null);
  return ['Video', when && formatWhen(when), formatLength(duration)].filter(Boolean).join(' · ');
}
