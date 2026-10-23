// Streams files that MSE can't take directly (MKV, WebM, MPEG-TS, or MP4/MOV with AC-3/DTS/PCM sound)
// as fragmented MP4, built in the host's browser with Mediabunny:
//   - video packets are copied untouched (full quality, no re-encoding),
//   - sound is copied if it's already AAC, otherwise decoded and re-encoded to AAC stereo.
// Output keeps the original timestamps, so after a seek the guest's MSE buffer lines up.

const LIB = 'mediabunny';
const EXTENSIONS = {
  ac3: ['/vendor/mediabunny-ac3/mediabunny-ac3.mjs', 'registerAc3Decoder'],
  eac3: ['/vendor/mediabunny-ac3/mediabunny-ac3.mjs', 'registerAc3Decoder'],
  dts: ['/vendor/mediabunny-dts/mediabunny-dts.mjs', 'registerDtsDecoder'],
};
const AAC_BITRATE = 160_000;
const loaded = new Set();

/** Load (once) and register a decoder/encoder extension. */
async function loadExtension(url, fn) {
  if (loaded.has(fn)) return;
  const mod = await import(url);
  mod[fn]();
  loaded.add(fn);
}

export class RemuxSource {
  constructor(file) {
    this.file = file;
    this.run = null;
  }

  /**
   * Open the file and work out what needs converting.
   * @returns {Promise<{duration: number, codecs: string, videoCodec: string, transcodeAudio: boolean}>}
   */
  async probe() {
    const MB = (this.MB = await import(LIB));
    const input = (this.input = new MB.Input({ source: new MB.BlobSource(this.file), formats: MB.ALL_FORMATS }));
    if (!(await input.canRead())) {
      throw new Error(
        "This file type isn't supported (e.g. old AVI/WMV). Convert it to MP4 first, " +
          'for example with HandBrake (free): handbrake.fr'
      );
    }
    const video = (this.video = await input.getPrimaryVideoTrack());
    if (!video) throw new Error('No video track found in this file.');
    const videoCodec = await video.getCodecParameterString();
    if (!videoCodec || !['avc', 'hevc', 'vp9', 'av1', 'vp8'].includes(video.codec)) {
      throw new Error(`This video codec (${video.codec || 'unknown'}) can't be streamed. Convert the file to H.264 MP4.`);
    }
    this.videoConfig = await video.getDecoderConfig();

    const audio = (this.audio = await input.getPrimaryAudioTrack());
    let audioCodec = null;
    if (audio) {
      if (audio.codec === 'aac') {
        this.transcodeAudio = false;
        audioCodec = (await audio.getCodecParameterString()) || 'mp4a.40.2';
        this.audioConfig = await audio.getDecoderConfig();
      } else {
        this.transcodeAudio = true;
        const ext = EXTENSIONS[audio.codec];
        if (ext && !(await audio.canDecode())) await loadExtension(...ext);
        if (!(await audio.canDecode())) {
          console.warn('Cannot decode audio', audio.codec);
          this.audio = null; // play without sound rather than not at all
        } else {
          const opts = { numberOfChannels: 2, sampleRate: audio.sampleRate || 48000 };
          if (!(await MB.canEncodeAudio('aac', opts))) {
            await loadExtension('/vendor/mediabunny-aac-encoder/mediabunny-aac-encoder.mjs', 'registerAacEncoder');
          }
          audioCodec = 'mp4a.40.2';
        }
      }
    }
    this.audioWasDropped = !!audio && !this.audio;
    this.audioDescription = audio ? `${audio.codec}${audio.numberOfChannels > 2 ? ` ${audio.numberOfChannels}ch` : ''}` : null;

    const duration = (await input.getDurationFromMetadata()) ?? (await input.computeDuration());
    return {
      duration,
      videoCodec,
      codecs: [videoCodec, audioCodec].filter(Boolean).join(', '),
      transcodeAudio: !!this.audio && this.transcodeAudio,
    };
  }

  /**
   * Produce fragmented MP4 from the keyframe at/before `startTime`. `onData(bytes, {init})` is
   * awaited for every chunk, so a slow consumer (DataChannel backpressure, guest buffer full)
   * slows the whole pipeline down. Returns once the end of the file is reached or `cancel()`.
   */
  async start(startTime, onData) {
    await this.cancel();
    const MB = this.MB;
    const run = (this.run = { canceled: false });
    const splitter = new BoxSplitter();
    const writable = new WritableStream(
      {
        write: async (chunk) => {
          if (run.canceled) return;
          for (const piece of splitter.push(chunk)) {
            if (run.canceled) return;
            await onData(piece.bytes, { init: piece.init });
          }
        },
      },
      { highWaterMark: 1 }
    );
    const output = (run.output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
      target: new MB.AppendOnlyStreamTarget(writable),
    }));

    const videoSink = new MB.EncodedPacketSink(this.video);
    const videoSource = new MB.EncodedVideoPacketSource(this.video.codec);
    output.addVideoTrack(videoSource, { rotation: this.video.rotation });

    let audioJob = null;
    if (this.audio) {
      if (!this.transcodeAudio) {
        const sink = new MB.EncodedPacketSink(this.audio);
        const source = new MB.EncodedAudioPacketSource('aac');
        output.addAudioTrack(source);
        audioJob = { sink, source, copy: true };
      } else {
        const sink = new MB.AudioSampleSink(this.audio);
        const source = new MB.AudioSampleSource({
          codec: 'aac',
          bitrate: AAC_BITRATE,
          transform: { numberOfChannels: 2 },
        });
        output.addAudioTrack(source);
        audioJob = { sink, source, copy: false };
      }
    }

    await output.start();
    const key = (await videoSink.getKeyPacket(Math.max(0, startTime))) ?? (await videoSink.getFirstKeyPacket());
    if (!key || run.canceled) return;
    const t0 = key.timestamp;
    run.startTime = t0;

    const pumpVideo = async () => {
      let first = true;
      for await (const packet of videoSink.packets(key)) {
        if (run.canceled) return;
        await videoSource.add(packet, first ? { decoderConfig: this.videoConfig } : undefined);
        first = false;
      }
      videoSource.close();
    };
    const pumpAudio = async () => {
      if (!audioJob) return;
      if (audioJob.copy) {
        const startPacket = (await audioJob.sink.getPacket(t0)) ?? (await audioJob.sink.getFirstPacket());
        let first = true;
        if (startPacket) {
          for await (const packet of audioJob.sink.packets(startPacket)) {
            if (run.canceled) return;
            await audioJob.source.add(packet, first ? { decoderConfig: this.audioConfig } : undefined);
            first = false;
          }
        }
      } else {
        for await (const sample of audioJob.sink.samples(t0)) {
          if (run.canceled) {
            sample.close();
            return;
          }
          await audioJob.source.add(sample);
          sample.close();
        }
      }
      audioJob.source.close();
    };

    try {
      await Promise.all([pumpVideo(), pumpAudio()]);
      if (!run.canceled) await output.finalize();
    } catch (err) {
      if (!run.canceled) throw err;
    }
  }

  async cancel() {
    const run = this.run;
    if (!run) return;
    run.canceled = true;
    this.run = null;
    try {
      await run.output?.cancel();
    } catch {}
  }

  dispose() {
    this.cancel();
    this.input?.dispose?.();
  }
}

/**
 * Splits a sequential fragmented-MP4 byte stream into pieces: the init segment (ftyp + moov) as one
 * piece flagged `init`, and everything after it passed through as-is (moof/mdat may be split
 * across pieces, which MSE accepts).
 */
class BoxSplitter {
  constructor() {
    this.pending = new Uint8Array(0);
    this.initDone = false;
  }

  push(chunk) {
    if (this.initDone) return [{ bytes: chunk, init: false }];
    const buf = concat(this.pending, chunk);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    while (o + 8 <= buf.length) {
      const size = dv.getUint32(o);
      const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      if (type !== 'ftyp' && type !== 'moov' && type !== 'free') {
        // First media box: everything before it is the init segment.
        this.initDone = true;
        const out = [{ bytes: buf.slice(0, o), init: true }];
        if (o < buf.length) out.push({ bytes: buf.slice(o), init: false });
        this.pending = new Uint8Array(0);
        return out;
      }
      if (o + size > buf.length) break;
      o += size;
    }
    this.pending = buf;
    return [];
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
