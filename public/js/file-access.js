// Making sure the movie the host picked can actually be read.
//
// On Android a picked file is a link into whichever app holds it (Gallery, Google Photos, Drive…).
// Some of those apps can only hand a video over front to back and can't jump into the middle,
// which is how the player reads a movie (e.g. a video that's only partly downloaded from the
// cloud). Others refuse every read (a cloud-only video, or one that changed after it was picked).
// Chrome reports both as "The requested file could not be read…" (NotReadableError).
// For the first kind we copy the movie once into this site's private storage on the device and
// play the copy; for the second we say what to do instead.

const PROBE_BYTES = 64 * 1024;
const COPY_DIR = 'movie-copies';
const MAX_MEMORY_COPY = 500 * 1024 * 1024; // without private storage, only copy this much into memory
const MB = 1024 * 1024;

const UNREADABLE =
  "Your phone wouldn't let the browser read this video. It's probably in Google Photos, Drive or " +
  'another cloud app and not fully saved on the phone. Download it to the phone first (in Google ' +
  'Photos: ⋮ → Download), then choose it from Files → Videos or Downloads.';

export class UnreadableFileError extends Error {}

/** Did reading the file fail because the device refused (rather than a format problem)? */
export function isReadError(err) {
  return err?.name === 'NotReadableError' || err?.name === 'NotFoundError' || /could not be read/i.test(err?.message);
}

/** Can `blob` be read at `offset`, both ways the player reads (a slice, and a stream from there)? */
async function canRead(blob, offset) {
  try {
    await blob.slice(offset, offset + PROBE_BYTES).arrayBuffer();
    const reader = blob.slice(offset).stream().getReader();
    await reader.read();
    reader.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve with a File the player can read anywhere in: the original, or a private copy of it when
 * the device can only read it front to back. `onProgress(fraction)` reports the copy's progress.
 * Throws UnreadableFileError (with an explanation for the user) when it can't be read at all.
 */
export async function readableFile(file, onProgress) {
  let fromStart = await canRead(file, 0);
  if (!fromStart) {
    // A cloud app may still be fetching it: give it a moment, once.
    await new Promise((r) => setTimeout(r, 1500));
    fromStart = await canRead(file, 0);
  }
  if (!fromStart) throw new UnreadableFileError(UNREADABLE);
  const middle = Math.floor(file.size / 2);
  const end = Math.max(0, file.size - PROBE_BYTES);
  if ((await canRead(file, middle)) && (await canRead(file, end))) return file;
  return copyFile(file, onProgress);
}

/** Read the whole file front to back into private storage (or memory if it's small enough). */
async function copyFile(file, onProgress) {
  await clearMovieCopies(); // only one movie at a time: free the space an earlier copy took
  const dir = await copyDirectory();
  if (dir) {
    const { quota = Infinity, usage = 0 } = (await navigator.storage.estimate?.().catch(() => null)) ?? {};
    if (quota - usage < file.size + 100 * MB) {
      const need = Math.ceil((file.size + 100 * MB) / (1024 * MB));
      throw new UnreadableFileError(
        `This video can only be played after copying it into the browser, and that needs about ${need} GB of free space. Free up some space, or download the video to the phone first and choose it from Files.`
      );
    }
    const name = file.name.replace(/[\\/:*?"<>|]/g, '_') || 'movie';
    const handle = await dir.getFileHandle(name, { create: true });
    const out = await handle.createWritable();
    try {
      await pipe(file, (chunk) => out.write(chunk), onProgress);
      await out.close();
    } catch (err) {
      await out.abort?.().catch(() => {});
      await dir.removeEntry(name).catch(() => {});
      throw err instanceof UnreadableFileError ? err : new UnreadableFileError(UNREADABLE);
    }
    const copy = await handle.getFile();
    return new File([copy], file.name, { type: file.type, lastModified: file.lastModified });
  }
  if (file.size > MAX_MEMORY_COPY) throw new UnreadableFileError(UNREADABLE);
  const parts = [];
  try {
    await pipe(file, (chunk) => parts.push(chunk), onProgress);
  } catch {
    throw new UnreadableFileError(UNREADABLE);
  }
  return new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
}

async function pipe(file, write, onProgress) {
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    await write(value);
    done += value.byteLength;
    onProgress?.(done / file.size);
  }
  if (done !== file.size) throw new UnreadableFileError(UNREADABLE);
}

async function copyDirectory() {
  try {
    if (!('createWritable' in FileSystemFileHandle.prototype)) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(COPY_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Delete earlier private copies (they're only needed while that movie is playing). */
export async function clearMovieCopies() {
  try {
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(COPY_DIR, { recursive: true });
  } catch {}
}
