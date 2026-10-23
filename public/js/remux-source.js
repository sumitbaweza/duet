// Turns any file Mediabunny can read (MP4, MOV, MKV, WebM, MPEG-TS…) into a stream of fragmented MP4
// pieces, built in the host's browser:
//   - "copy" (original quality): video packets are copied untouched,
//   - a quality rung (e.g. 720p @ 3 Mbps): video is decoded, resized and re-encoded to H.264 with the
//     device's hardware encoder, so a 4K movie fits through a slower connection (like YouTube's
//     quality levels, but made live on the host instead of on a server).
// Sound is copied if it's already AAC, otherwise decoded and re-encoded to AAC stereo.
// Output keeps the original timestamps, so after a seek or quality switch the guest's MSE buffer lines up.

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

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export class RemuxSource {
  constructor(file) {
    this.file = file;
    this.run = null;
  }

  /**
   * Open the file and work out what needs converting.
   * @returns {Promise<{duration: number, codecs: string, videoCodec: string, transcodeAudio: boolean,
   *   width: number, height: number, fps: number, bitrate: number}>}
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
    const videoCodec = (this.videoCodec = await video.getCodecParameterString());
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
    this.audioCodec = audioCodec;
    this.audioWasDropped = !!audio && !this.audio;
    this.audioDescription = audio ? `${audio.codec}${audio.numberOfChannels > 2 ? ` ${audio.numberOfChannels}ch` : ''}` : null;

    const duration = (this.duration = (await input.getDurationFromMetadata()) ?? (await input.computeDuration()));
    // Displayed size (after phone rotation) and a quick look at frame rate / bitrate.
    this.width = await video.getDisplayWidth();
    this.height = await video.getDisplayHeight();
    const stats = await video.computePacketStats(240).catch(() => null);
    this.fps = stats?.averagePacketRate || 30;
    // Whole-file average is the most honest number for "how much data per second must be sent".
    this.bitrate = duration > 0 ? (this.file.size * 8) / duration : stats?.averageBitrate || 0;
    return {
      duration,
      videoCodec,
      codecs: this.mime(videoCodec),
      transcodeAudio: !!this.audio && this.transcodeAudio,
      width: this.width,
      height: this.height,
      fps: this.fps,
      bitrate: this.bitrate,
    };
  }

  /** The codecs="…" list for a run using this video codec string. */
  mime(videoCodecString) {
    return [videoCodecString, this.audio ? this.audioCodec : null].filter(Boolean).join(', ');
  }

  /** Whether this device can re-encode to H.264 at the given size (encoder present, etc.). */
  async canTranscode(short, bitrate) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return false;
    const { w, h } = this.encodeSize(short);
    return !!(await pickEncoderConfig(w, h, this.fps, bitrate));
  }

  /**
   * Encoded frame size for a quality rung: the short side becomes `short`, keeping the aspect ratio.
   * In the file's stored orientation (phone rotation is kept as metadata, like the original).
   */
  encodeSize(short) {
    const W = this.video.codedWidth;
    const H = this.video.codedHeight;
    const scale = Math.min(1, short / Math.min(W, H));
    return { w: even(W * scale), h: even(H * scale) };
  }

  /**
   * Produce fragmented MP4 starting at `startTime` (at/before it for copied video). `onData(bytes,
   * {init, mime})` is awaited for every chunk, so a slow consumer (DataChannel backpressure, guest
   * buffer full) slows the whole pipeline down. `variant` is null for original quality, or
   * {short, bitrate} to re-encode. Returns at the end of the file or after `cancel()`.
   */
  async start(startTime, onData, variant = null) {
    await this.cancel();
    const MB = this.MB;
    const run = (this.run = { canceled: false, variant, startedAt: performance.now(), mediaTime: startTime });
    const splitter = new BoxSplitter();
    const writable = new WritableStream(
      {
        write: async (chunk) => {
          if (run.canceled) return;
          for (const piece of splitter.push(chunk)) {
            if (run.canceled) return;
            await onData(piece.bytes, { init: piece.init, mime: piece.init ? this.mime(run.videoCodec) : undefined });
          }
        },
      },
      { highWaterMark: 1 }
    );
    const output = (run.output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
      target: new MB.AppendOnlyStreamTarget(writable),
    }));

    let pumpVideo;
    if (!variant) {
      run.videoCodec = this.videoCodec;
      const sink = new MB.EncodedPacketSink(this.video);
      const source = new MB.EncodedVideoPacketSource(this.video.codec);
      output.addVideoTrack(source, { rotation: this.video.rotation });
      pumpVideo = async (key) => {
        let first = true;
        for await (const packet of sink.packets(key)) {
          if (run.canceled) return;
          await source.add(packet, first ? { decoderConfig: this.videoConfig } : undefined);
          run.mediaTime = packet.timestamp;
          first = false;
        }
        source.close();
      };
      run.keySink = sink;
    } else {
      const { w, h } = this.encodeSize(variant.short);
      const encoderConfig = await pickEncoderConfig(w, h, this.fps, variant.bitrate);
      if (!encoderConfig) throw new Error(`This device can't encode ${variant.short}p H.264.`);
      run.videoCodec = encoderConfig.codec;
      const source = new MB.EncodedVideoPacketSource('avc');
      output.addVideoTrack(source, { rotation: this.video.rotation });
      pumpVideo = () => this.transcodeVideo(run, startTime, source, encoderConfig);
    }

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
    let t0 = Math.max(0, startTime);
    let key = null;
    if (!variant) {
      key = (await run.keySink.getKeyPacket(t0)) ?? (await run.keySink.getFirstKeyPacket());
      if (!key || run.canceled) return;
      t0 = key.timestamp;
    }
    run.startTime = t0;

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
      await Promise.all([pumpVideo(key), pumpAudio()]);
      if (!run.canceled) await output.finalize();
      run.done = !run.canceled; // converted through to the end of the movie
    } catch (err) {
      if (!run.canceled) throw err;
    }
  }

  /**
   * Live re-encode: hardware decode of the original → GPU resize → hardware H.264 encode, with the
   * three stages running concurrently (≈2.4× faster than decoding/resizing/encoding one frame at a
   * time). Output starts with a keyframe exactly at `startTime`, then one every 2 s.
   */
  async transcodeVideo(run, startTime, source, encoderConfig) {
    const MB = this.MB;
    const sink = new MB.EncodedPacketSink(this.video);
    const key = (await sink.getKeyPacket(startTime)) ?? (await sink.getFirstKeyPacket());
    if (!key || run.canceled) return;
    let decoderConfig = { ...this.videoConfig, hardwareAcceleration: 'prefer-hardware' };
    if (!(await VideoDecoder.isConfigSupported(decoderConfig)).supported) decoderConfig = { ...this.videoConfig };

    const signal = new EventTarget();
    const notify = () => signal.dispatchEvent(new Event('work'));
    const waitWork = () =>
      new Promise((resolve) => {
        signal.addEventListener('work', resolve, { once: true });
        setTimeout(resolve, 30);
      });
    const frames = []; // decoded, waiting to be resized + encoded
    const encoded = []; // encoded chunks waiting to be muxed
    let error = null;
    let decodeDone = false;
    let encodeDone = false;
    const startUs = startTime * 1e6 - 1000;

    const decoder = new VideoDecoder({
      output: (frame) => {
        if (run.canceled || frame.timestamp < startUs) frame.close(); // before the seek point
        else frames.push(frame);
        notify();
      },
      error: (e) => {
        error ||= e;
        notify();
      },
    });
    decoder.configure(decoderConfig);
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        encoded.push({ chunk, meta });
        notify();
      },
      error: (e) => {
        error ||= e;
        notify();
      },
    });
    encoder.configure(encoderConfig);
    const { width: w, height: h } = encoderConfig;
    const stop = () => run.canceled || error;

    const feed = (async () => {
      for await (const packet of sink.packets(key)) {
        if (stop()) break;
        while (!stop() && (frames.length > 6 || decoder.decodeQueueSize > 8 || encoded.length > 90)) await waitWork();
        if (stop()) break;
        decoder.decode(packet.toEncodedVideoChunk());
      }
      if (!stop()) await decoder.flush().catch((e) => (error ||= e));
      decodeDone = true;
      notify();
    })();

    // Resize by drawing onto a GPU canvas (measured ~13% faster than createImageBitmap resizing).
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const encode = (async () => {
      let lastKey = -Infinity;
      for (;;) {
        if (stop()) break;
        if (!frames.length) {
          if (decodeDone) break;
          await waitWork();
          continue;
        }
        const f = frames.shift();
        const timestamp = f.timestamp;
        let frame = f;
        if (f.displayWidth !== w || f.displayHeight !== h) {
          ctx.drawImage(f, 0, 0, w, h);
          f.close();
          frame = new VideoFrame(canvas, { timestamp });
        }
        const keyFrame = timestamp / 1e6 - lastKey >= 2;
        if (keyFrame) lastKey = timestamp / 1e6;
        run.framesIn = (run.framesIn || 0) + 1;
        encoder.encode(frame, { keyFrame });
        frame.close();
        while (!stop() && encoder.encodeQueueSize > 8) await waitWork();
      }
      if (!stop()) await encoder.flush().catch((e) => (error ||= e));
      encodeDone = true;
      notify();
    })();

    let first = true;
    for (;;) {
      if (stop()) break;
      if (!encoded.length) {
        if (encodeDone) break;
        await waitWork();
        continue;
      }
      const { chunk, meta } = encoded.shift();
      run.framesOut = (run.framesOut || 0) + 1;
      await source.add(MB.EncodedPacket.fromEncodedChunk(chunk), first ? { decoderConfig: meta?.decoderConfig } : undefined);
      run.mediaTime = chunk.timestamp / 1e6;
      first = false;
    }

    for (const f of frames.splice(0)) f.close();
    for (const c of [decoder, encoder]) {
      try {
        c.close();
      } catch {}
    }
    await Promise.allSettled([feed, encode]);
    if (error && !run.canceled) throw error;
    if (!run.canceled) source.close();
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
 * First H.264 encoder setup this device supports for the size: High profile at a fitting level,
 * then Main, then Baseline; hardware preferred.
 */
async function pickEncoderConfig(width, height, fps, bitrate) {
  const fast = fps > 31;
  const level =
    width * height > 1280 * 720 ? (fast ? '2a' : '28') : width * height > 854 * 480 ? (fast ? '20' : '1f') : fast ? '1f' : '1e';
  for (const profile of ['6400', '4d00', '42e0']) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const config = {
        codec: `avc1.${profile}${level}`,
        width,
        height,
        bitrate,
        framerate: Math.round(fps) || 30,
        hardwareAcceleration,
        latencyMode: 'quality',
        avc: { format: 'avc' },
      };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch {}
    }
  }
  return null;
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
