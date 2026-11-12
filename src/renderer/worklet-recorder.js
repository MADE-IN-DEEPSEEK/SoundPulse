/* SoundPulse — AudioWorklet-процессор записи микрофона.
   Копит Float32 и шлёт чанки в главный поток. */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.acc = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.buf.push(new Float32Array(ch));
    this.acc += ch.length;
    if (this.acc >= 4096) {
      const out = new Float32Array(this.acc);
      let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out);
      this.buf = [];
      this.acc = 0;
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);