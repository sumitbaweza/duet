// One RTCPeerConnection between the two people, using the "perfect negotiation" pattern
// so either side can add a mic/camera at any time without offer collisions.
//
// Two data channels, pre-negotiated with fixed ids so both sides create them symmetrically:
//   control (id 0): small JSON sync messages (play/pause/seek/heartbeat/reactions)
//   video   (id 1): fMP4 segments, host -> guest. Kept separate so a 5 MB segment never
//                   delays a pause command (no head-of-line blocking for control).

export class Peer extends EventTarget {
  /**
   * @param {{polite: boolean, iceServers: RTCIceServer[], sendSignal: (data: object) => void}} opts
   */
  constructor({ polite, iceServers, sendSignal }) {
    super();
    this.polite = polite;
    this.sendSignal = sendSignal;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.closed = false;

    const pc = (this.pc = new RTCPeerConnection({ iceServers }));
    this.control = pc.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
    this.video = pc.createDataChannel('video', { negotiated: true, id: 1, ordered: true });
    this.video.binaryType = 'arraybuffer';

    pc.onnegotiationneeded = () => {
      // The host always makes the first offer. If the guest offered at the same time and either
      // side already had a mic/camera track, the two offers' media sections conflict and both
      // sides renegotiate forever. So the guest holds its offer until the first handshake is done.
      if (this.polite && !pc.currentRemoteDescription) {
        this.deferredNegotiation = true;
        return;
      }
      this.negotiate();
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ candidate });
    };
    pc.ontrack = ({ track, streams }) => {
      this.dispatchEvent(new CustomEvent('track', { detail: { track, stream: streams[0] } }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      this.dispatchEvent(new CustomEvent('state', { detail: pc.connectionState }));
    };

    this.control.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent('control', { detail: msg }));
    };
    this.control.onopen = () => this.dispatchEvent(new Event('open'));
    this.control.onclose = () => this.dispatchEvent(new Event('close'));
  }

  async negotiate() {
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this.sendSignal({ description: this.pc.localDescription });
    } catch (err) {
      console.error('negotiation failed', err);
    } finally {
      this.makingOffer = false;
    }
  }

  /** Signals are applied strictly in arrival order (a candidate must never overtake its offer). */
  handleSignal(signal) {
    this.signalChain = (this.signalChain || Promise.resolve()).then(() => this.applySignal(signal));
    return this.signalChain;
  }

  async applySignal({ description, candidate }) {
    if (this.closed) return;
    const pc = this.pc;
    try {
      if (description) {
        const offerCollision =
          description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.sendSignal({ description: pc.localDescription });
          // Now send anything we held back (e.g. our mic/camera that was on before connecting).
          if (this.deferredNegotiation) {
            this.deferredNegotiation = false;
            this.negotiate();
          }
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('signal handling failed', err);
    }
  }

  sendControl(msg) {
    if (this.control.readyState === 'open') this.control.send(JSON.stringify(msg));
  }

  get isOpen() {
    return this.control.readyState === 'open';
  }

  /** Largest single message the SCTP transport accepts, capped at 64 KB for Safari/Firefox interop. */
  get maxChunk() {
    const max = this.pc.sctp?.maxMessageSize || 16 * 1024;
    return Math.max(16 * 1024, Math.min(64 * 1024, max));
  }

  /** "direct" or "relay" (TURN), plus round-trip time, from the selected ICE candidate pair. */
  async connectionInfo() {
    const stats = await this.pc.getStats();
    let pair;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
    }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    return {
      mode: relayed ? 'relay' : 'direct',
      rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  }

  close() {
    this.closed = true;
    try {
      this.pc.close();
    } catch {}
  }
}
