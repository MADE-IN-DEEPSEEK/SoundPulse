/* SoundPulse — AudioEngine: два AudioContext (колонки / микрофон) с setSinkId,
   цепочка эффектов master -> WaveShaper (fart) -> lowshelf, нормализация EBU,
   voice activation, фейды. */

const NORM_TARGET = 0.2; // ~ -14 dBFS

class AudioEngine {
  constructor() {
    this.spkCtx = null; // speakers (default output)
    this.micCtx = null; // microphone path (virtual cable via setSinkId)
    this.buffers = new Map();   // path -> cached AudioBuffer (or null)
    this.normGain = new Map();  // path -> normalization gain
    this.decoder = null;
    this.active = new Map();    // soundId -> nodes (последняя группа)
    this.live = new Set();      // ВСЕ живые группы {id, nodes} — стоп galвательно глушит каждую
    this.voiceNode = null;

    this.speakerDeviceId = '';
    this.micDeviceId = '';
    this.masterVolume = 1;
    this.mute = false;
    this.selfOff = false;
    this.monitorVol = 0.39;
    this.monitor = true;
    this.fartLevel = 0;
    this.normalize = false;
    this.voiceActivation = false;

    // дакинг: когда говоришь в микрофон — музыка приглушается
    this.ducking = false;
    this.duckAmount = 0.28;      // до какой громкости падать (28%)
    this.duckThreshold = 0.018;  // порог голоса (RMS)
    this.duckStream = null;
    this.duckCtx = null;
    this.duckAnalyser = null;
    this.duckData = null;
    this.duckRaf = 0;
    this.duckLastVoice = 0;
    this.duckOn = false;
    this.duckDeviceId = '';       // физический микрофон (НЕ виртуальный кабель)

    // голос: SoundPulse как виртуальный микрофон
    this.voiceWanted = false;
    this.voiceStream = null;
    this.voiceSrcNode = null;
    this.voiceHPNode = null;
    this.voiceCompNode = null;     // выравнивание громкости голоса
    this.voiceMakeupNode = null;   // компенсация уровня
    this.voiceLimitNode = null;    // защита от клиппинга
    this.voiceGateNode = null;
    this.voiceVolNode = null;
    this.voiceAnalyser = null;
    this.voiceOutAnalyser = null;
    this.voiceOutData = null;
    this.voiceData = null;
    this.voiceTimer = 0;
    this.voiceLevel = 0;
    this.voiceVolume = 1;         // 0..2
    this.voiceGate = 0;           // 0 = выкл, иначе порог RMS
    this._voiceGateOpen = true;
    this._voiceGateLastAbove = 0;
    this.onVoiceLevel = null;     // колбэк для индикатора
  }

  ensure() {
    if (!this.spkCtx) {
      this.decoder = new AudioContext();
      this.spkCtx = this.makeCtx('spk');
      this.micCtx = this.makeCtx('mic');
      // общий гейн «слышу я»: отдельная громкость для своих ушей (регулятор «Мне»)
      // подключаем ПОСЛЕ эффектов (fart -> shelf -> atten), чтобы ты слышал обработанный звук
      this.spkCtx.monGain = this.spkCtx.ctx.createGain();
      this.spkCtx.monGain.connect(this.spkCtx.atten);
      this.applyLevels();
    }
  }

  makeCtx(kind) {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // chain: master -> fart(waveshaper) -> teleHP -> teleLP -> lowshelf -> atten -> analyser -> destination
    const master = ctx.createGain();
    const fart = ctx.createWaveShaper();
    fart.oversample = 'none';
    // «кнопочный телефон»: полоса 300–3400 Гц как в старом сотовом/звонке
    const teleHp = ctx.createBiquadFilter();
    teleHp.type = 'highpass';
    teleHp.frequency.value = 10;
    teleHp.Q.value = 0.7;
    const teleLp = ctx.createBiquadFilter();
    teleLp.type = 'lowpass';
    teleLp.frequency.value = 20000;
    teleLp.Q.value = 0.7;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 110;
    shelf.Q.value = 1.0;
    shelf.gain.value = 0;
    const atten = ctx.createGain();
    atten.gain.value = 1;
    const duck = ctx.createGain();
    duck.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.75;
    // Шина голоса: идёт ПОСЛЕ эффектов, поэтому голос не окрашивается
    // «БАСАМИ»/«РАЦИЕЙ» и не режется общей громкостью музыки.
    const voiceBus = ctx.createGain();
    voiceBus.gain.value = 1;
    master.connect(fart);
    fart.connect(teleHp);
    teleHp.connect(teleLp);
    teleLp.connect(shelf);
    shelf.connect(atten);
    atten.connect(duck);
    duck.connect(analyser);
    voiceBus.connect(analyser);
    analyser.connect(ctx.destination);
    return { ctx, master, fart, teleHp, teleLp, shelf, atten, duck, analyser, voiceBus, kind, monGain: null };
  }

  setMicDevice(id) {
    this.micDeviceId = id || '';
    this.ensure();
    if (this.micCtx) {
      return this.micCtx.ctx.setSinkId(this.micDeviceId || '').catch((e) => console.error('setSinkId(mic)', e));
    }
    return Promise.resolve();
  }
  setSpeakerDevice(id) {
    this.speakerDeviceId = id || '';
    this.ensure();
    if (this.spkCtx) {
      return this.spkCtx.ctx.setSinkId(this.speakerDeviceId || '').catch((e) => console.error('setSinkId(spk)', e));
    }
    return Promise.resolve();
  }
  setVolume(v) { this.masterVolume = v; this.ensure(); this.applyLevels(); }
  setMute(b) { this.mute = b; this.ensure(); this.applyLevels(); }
  // self-listen kill: вырубить speaker-канал, mic-канал остаётся
  setSelfOff(b) { this.selfOff = !!b; this.ensure(); this.applyLevels(); }
  setMonitorVol(v) {
    this.monitorVol = v;
    this.ensure();
    this.applyLevels();
  }
  setMonitor(b) {
    this.monitor = !!b;
    this.ensure();
    this.applyLevels();
  }
  setFart(level) {
    this.fartLevel = level;
    this.ensure();
    this.applyLevels();
  }
  setNormalize(b) { this.normalize = b; }
  setVoiceActivation(b) { this.voiceActivation = b; }

  // ---------- голос: SoundPulse сам микширует микрофон в виртуальный выход ----------
  // Включается только по желанию: у кого есть Sonar — голос чистит он, и микшировать
  // здесь нельзя (получится двойной голос).
  setVoiceVolume(v) {
    const n = Number(v);
    if (!isFinite(n)) return;
    this.voiceVolume = Math.max(0, Math.min(2, n));
    if (this.voiceVolNode) {
      try { this.voiceVolNode.gain.value = this.voiceVolume; } catch {}
    }
  }

  setVoiceGate(v) {
    const n = Number(v);
    if (!isFinite(n)) return;
    this.voiceGate = Math.max(0, Math.min(0.12, n));
  }

  getVoiceLevel() { return this.voiceLevel || 0; }

  async startVoice(deviceId) {
    this.ensure();
    if (!this.micCtx) return false;
    this.voiceWanted = true;
    this._stopVoiceNodes();
    try {
      // Сырой сигнал без обработки Chromium: AEC/шумодав/AGC режут и «дёргают»
      // голос, из-за этого он звучит тихо и обрывисто. Всё делаем сами.
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (!this.voiceWanted) { stream.getTracks().forEach((t) => t.stop()); return false; }
      const ctx = this.micCtx.ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);

      // Оригинальный микрофон, без «улучшайзеров»: только срез инфраниза
      // и страховочный лимитер на самом верху шкалы. Никакого буста и
      // компрессии — 100% на ползунке значит «как есть с микрофона».
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 40;
      hp.Q.value = 0.7;

      // срабатывает только если сигнал уже почти в потолке, иначе прозрачен
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;

      const gate = ctx.createGain();
      this._voiceGateOpen = !(this.voiceGate > 0);
      this._voiceGateLastAbove = 0;
      gate.gain.value = this._voiceGateOpen ? 1 : 0;
      const vol = ctx.createGain();
      vol.gain.value = this.voiceVolume;

      src.connect(hp);
      hp.connect(limiter);
      limiter.connect(gate);
      gate.connect(vol);
      // в обход эффектов и общей громкости музыки
      vol.connect(this.micCtx.voiceBus);

      // «до» — для ворот, «после» — для индикатора, чтобы он показывал
      // то, что реально уходит собеседнику
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.5;
      src.connect(an);
      const outAn = ctx.createAnalyser();
      outAn.fftSize = 512;
      outAn.smoothingTimeConstant = 0.4;
      vol.connect(outAn);

      this.voiceStream = stream;
      this.voiceSrcNode = src;
      this.voiceHPNode = hp;
      this.voiceLimitNode = limiter;
      this.voiceGateNode = gate;
      this.voiceVolNode = vol;
      this.voiceAnalyser = an;
      this.voiceOutAnalyser = outAn;
      this.voiceData = new Float32Array(an.fftSize);
      this.voiceOutData = new Float32Array(outAn.fftSize);

      const tick = () => {
        if (!this.voiceStream) return;
        an.getFloatTimeDomainData(this.voiceData);
        const d = this.voiceData;
        let sum = 0;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / d.length);
        let outRms = 0;
        try {
          outAn.getFloatTimeDomainData(this.voiceOutData);
          const o = this.voiceOutData;
          let s2 = 0;
          for (let i = 0; i < o.length; i++) s2 += o[i] * o[i];
          outRms = Math.sqrt(s2 / o.length);
        } catch {}
        this.voiceLevel = outRms;
        if (this.voiceGate > 0) {
          const now = performance.now();
          if (rms > this.voiceGate) {
            this._voiceGateLastAbove = now;
            if (!this._voiceGateOpen) {
              this._voiceGateOpen = true;
              try { gate.gain.setTargetAtTime(1, ctx.currentTime, 0.004); } catch {}
            }
          } else {
            // закрываем не сразу: иначе тихие слоги и окончания слов обрываются
            const quietFor = now - (this._voiceGateLastAbove || 0);
            if (this._voiceGateOpen && quietFor > 380) {
              this._voiceGateOpen = false;
              try { gate.gain.setTargetAtTime(0, ctx.currentTime, 0.12); } catch {}
            }
          }
        } else if (this._voiceGateOpen !== true) {
          this._voiceGateOpen = true;
          try { gate.gain.setValueAtTime(1, ctx.currentTime); } catch {}
        }
        if (this.onVoiceLevel) { try { this.onVoiceLevel(outRms); } catch {} }
      };
      tick();
      this.voiceTimer = setInterval(tick, 50);
      return true;
    } catch (e) {
      console.warn('voice: микрофон недоступен', e);
      this.voiceWanted = false;
      return false;
    }
  }

  stopVoice() {
    this.voiceWanted = false;
    if (this.voiceTimer) clearInterval(this.voiceTimer);
    this.voiceTimer = 0;
    this._stopVoiceNodes();
    this.voiceLevel = 0;
    if (this.onVoiceLevel) { try { this.onVoiceLevel(0); } catch {} }
  }

  _stopVoiceNodes() {
    if (this.voiceTimer) { clearInterval(this.voiceTimer); this.voiceTimer = 0; }
    if (this.voiceStream) {
      try { this.voiceStream.getTracks().forEach((t) => t.stop()); } catch {}
    }
    for (const n of [this.voiceSrcNode, this.voiceHPNode, this.voiceCompNode, this.voiceMakeupNode, this.voiceLimitNode, this.voiceGateNode, this.voiceVolNode, this.voiceAnalyser, this.voiceOutAnalyser]) {
      try { if (n) n.disconnect(); } catch {}
    }
    this.voiceStream = null;
    this.voiceSrcNode = null;
    this.voiceHPNode = null;
    this.voiceCompNode = null;
    this.voiceMakeupNode = null;
    this.voiceLimitNode = null;
    this.voiceGateNode = null;
    this.voiceVolNode = null;
    this.voiceAnalyser = null;
    this.voiceOutAnalyser = null;
    this.voiceData = null;
    this.voiceOutData = null;
    this._voiceGateOpen = false;
  }

  // ---------- дакинг: музыка тише, пока говоришь ----------
  setDuckAmount(v) {
    const n = Number(v);
    if (!isFinite(n)) return;
    this.duckAmount = Math.min(0.95, Math.max(0.05, n));
    this._applyDuck(this.duckOn, true);
  }

  setDucking(on) {
    this.ducking = !!on;
    this.ensure();
    if (!this.ducking) {
      this._stopDuckMic();
      this._applyDuck(false, true);
      return;
    }
    this._startDuckMic();
  }

  // Дакинг должен слушать ФИЗИЧЕСКИЙ микрофон. Если слушать виртуальный
  // (Sonar/CABLE), он слышит собственный звук SoundPulse и приглушает сам себя.
  setDuckDevice(id) {
    const next = id || '';
    if (this.duckDeviceId === next) return;
    this.duckDeviceId = next;
    if (this.ducking && this.duckStream) this._startDuckMic(true);
  }

  async _startDuckMic(restart) {
    if (restart) this._stopDuckMic();
    if (this.duckStream) return;
    try {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (this.duckDeviceId) audio.deviceId = { exact: this.duckDeviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (!this.ducking) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.duckStream = stream;
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.55;
      src.connect(an);
      // держим граф «живым»: analyser без выхода в destination может не тянуться
      // (а нам нужно, чтобы данные анализатора обновлялись даже в фоне)
      const sink = ctx.createGain();
      sink.gain.value = 0;
      an.connect(sink);
      sink.connect(ctx.destination);
      this.duckCtx = ctx;
      this.duckAnalyser = an;
      this.duckData = new Float32Array(an.fftSize);
      this.duckLastVoice = 0;
      this.duckOn = false;
      const tick = () => {
        if (!this.duckStream || !this.duckAnalyser) return;
        // в свёрнутом окне / трее AudioContext может уснуть — будим
        if (this.duckCtx && this.duckCtx.state === 'suspended') this.duckCtx.resume().catch(() => {});
        this.duckAnalyser.getFloatTimeDomainData(this.duckData);
        let sum = 0;
        const d = this.duckData;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / d.length);
        const now = performance.now();
        if (rms > this.duckThreshold) this.duckLastVoice = now;
        const speaking = (now - this.duckLastVoice) < 380;
        if (speaking !== this.duckOn) {
          this.duckOn = speaking;
          this._applyDuck(speaking);
        }
      };
      // ВАЖНО: не requestAnimationFrame — он полностью замирает, когда окно
      // скрыто/свёрнуто, из-за чего приглушение переставало работать в трее.
      // Интервал + backgroundThrottling:false в главном окне работают в фоне.
      tick();
      this.duckRaf = setInterval(tick, 50);
    } catch (e) {
      console.warn('duck: микрофон недоступен', e);
    }
  }

  _stopDuckMic() {
    if (this.duckRaf) clearInterval(this.duckRaf);
    this.duckRaf = 0;
    if (this.duckStream) this.duckStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    if (this.duckCtx) { try { this.duckCtx.close(); } catch {} }
    this.duckStream = null;
    this.duckCtx = null;
    this.duckAnalyser = null;
    this.duckData = null;
    this.duckOn = false;
  }

  _applyDuck(on, instant) {
    for (const c of this.chains()) {
      if (!c.duck) continue;
      const g = c.duck.gain;
      const t = c.ctx.currentTime;
      try { g.cancelScheduledValues(t); } catch {}
      if (instant) { g.setValueAtTime(on ? this.duckAmount : 1, t); continue; }
      // вниз быстро, обратно плавно — без «дыхания» и щелчков
      g.setTargetAtTime(on ? this.duckAmount : 1, t, on ? 0.07 : 0.22);
    }
  }

  applyLevels() {
    // «Громкость» (masterVolume) = громкость в микрофон/кабель (что слышат собеседники).
    // «Мне» (monitorVol) = громкость в твоих динамиках. Уровни независимы.
    const micV = this.mute ? 0 : Math.max(0, this.masterVolume);
    for (const c of this.chains()) {
      c.master.gain.value = c.kind === 'mic' ? micV : 1;
      // голос идёт мимо эффектов — только мьют его глушит
      if (c.voiceBus) c.voiceBus.gain.value = this.mute ? 0 : 1;
      // эффекты: 1 = БАСЫ, 2 = ЖЕСТЬ, 3 = КНОПОЧНЫЙ, 4 = 425 БАЗА (рация)
      c.teleHp.frequency.value = 10;
      c.teleLp.frequency.value = 20000;
      c.teleHp.Q.value = 0.7;
      c.teleLp.Q.value = 0.7;
      if (this.fartLevel === 0) {
        c.fart.curve = null;
        c.shelf.gain.value = 0;
        c.atten.gain.value = 1;
      } else if (this.fartLevel === 1) {
        c.shelf.gain.value = 16;
        c.atten.gain.value = 1;
        const n = 17;
        const curve = new Float32Array(n);
        const k = 3;
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / (n - 1) - 1;
          curve[i] = Math.tanh(k * x) / Math.tanh(k);
        }
        c.fart.curve = curve;
      } else if (this.fartLevel === 2) {
        c.shelf.gain.value = 8;
        c.atten.gain.value = 0.35;
        const n = 41;
        const curve = new Float32Array(n);
        const k = 14;
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / (n - 1) - 1;
          curve[i] = Math.tanh(k * x) / Math.tanh(k);
        }
        c.fart.curve = curve;
      } else if (this.fartLevel === 3) {
        // 3: узкая полоса 380–2900 Гц + грубая оцифровка — «шакальный» звонок
        c.teleHp.frequency.value = 380;
        c.teleLp.frequency.value = 2900;
        c.teleHp.Q.value = 1.4;
        c.teleLp.Q.value = 1.4;
        c.shelf.gain.value = 5;
        c.atten.gain.value = 0.95;
        const n = 257;
        const steps = 6; // ~3 бита: слышимые «ступеньки» старого динамика
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / (n - 1) - 1;
          const q = Math.round(x * steps) / steps;
          curve[i] = Math.tanh(2.2 * q) / Math.tanh(2.2);
        }
        c.fart.curve = curve;
      } else {
        // 4: «425 База» — рация: ещё уже полоса, перегруз динамика и треск
        c.teleHp.frequency.value = 500;
        c.teleLp.frequency.value = 2600;
        c.teleHp.Q.value = 2.2;
        c.teleLp.Q.value = 2.2;
        c.shelf.gain.value = 0;
        c.atten.gain.value = 0.62;
        const n = 129;
        const steps = 4; // ~2 бита: грязная оцифровка рации
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / (n - 1) - 1;
          const q = Math.round(x * steps) / steps;
          curve[i] = Math.tanh(4.5 * q) / Math.tanh(4.5); // перегруз
        }
        c.fart.curve = curve;
      }
    }
    if (this.spkCtx && this.spkCtx.monGain) {
      this.spkCtx.monGain.gain.value = (this.mute || this.selfOff) ? 0 : (this.monitor ? Math.max(0, this.monitorVol) : 0);
    }
  }
  chains() { return [this.spkCtx, this.micCtx].filter(Boolean); }

  // decode + cache (with optional normalize gain)
  async getBuffer(path) {
    this.ensure();
    if (this.buffers.has(path)) return this.buffers.get(path);
    const p = (async () => {
      try {
        const res = await window.soundpad.fsRead(path);
        if (!res || !res.ok) return null;
        const bytes = res.data;
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const buf = await this.decoder.decodeAudioData(ab);
        if (this.normalize) {
          const rms = this.computeRms(buf);
          if (rms > 0.0001) this.normGain.set(path, Math.max(1, Math.min(6, NORM_TARGET / rms)));
        }
        return buf;
      } catch (e) {
        console.error('decode failed', path, e);
        return null;
      }
    })();
    this.buffers.set(path, p);
    return p;
  }

  // постепенный прогрев: декодируем файлы фоном, чтобы клик играл сразу;
  // порядок — по частоте использования (самое популярное готовится первым)
  async warmup(sounds, limit) {
    this.ensure();
    const list = sounds.slice().sort((a, b) => (b.plays || 0) - (a.plays || 0));
    let done = 0;
    for (const s of list) {
      if (limit && done >= limit) break;
      const p = s && s.path;
      if (!p || this.buffers.has(p)) continue;
      try { await this.getBuffer(p); } catch {}
      done++;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  computeRms(buf) {
    const data = buf.getChannelData(0);
    let sum = 0;
    const step = Math.max(1, Math.floor(data.length / 200000));
    for (let i = 0; i < data.length; i += step) sum += data[i] * data[i];
    return Math.sqrt(sum / Math.ceil(data.length / step));
  }

  /**
   * play(sound, targets, opts)
   * targets: ['mic'] | ['spk'] | ['mic','spk']
   * opts: { rate, offset, loop, fadeIn, fadeOut, monitor(force spk for mic listen), overlap }
   * returns handle { stop(), setVolume(v) }
   *
   * Гарантии:
   *  - каждая созданная группа попадает в this.live и никогда не теряется:
   *    стоп (по id или всё) глушит каждую группу.
   *  - при overlap с тем же id старые группы гасятся, новая играет.
   */
  async play(sound, targets, opts) {
    opts = opts || {};
    this.ensure();

    // Гонка запусков: клик A и B подряд — оба ждут декодирования, затем оба
    // стартуют, и играют две песни. Каждый не-overlap запуск получает номер,
    // устаревший после await просто выходит.
    const gen = (this._playGen = (this._playGen || 0) + 1);

    if (opts.overlap !== true) this.stopAll();
    else if (this.active.has(sound.id)) this.stop(sound.id);

    const buf = await this.getBuffer(sound.path);
    if (!buf) return null;
    if (opts.overlap !== true && gen !== this._playGen) return { aborted: true };

    const rate = opts.rate || 1;
    const offset = opts.offset || 0;
    const vol = (typeof sound.volume === 'number' ? sound.volume : 1) * (this.normGain.get(sound.path) || 1);

    const nodes = {};
    const group = { id: sound.id, nodes, ended: 0 };
    // Монитор-источник создаём ВСЕГДА, если звук идёт в микрофон и не идёт напрямую
    // в колонки. Слышимость решает только monGain: он учитывает «Мне», громкость
    // «Мне», самоглушение и mute. Так ползунок «Мне» работает на лету — стартовал
    // трек при 0%, поднял громкость — звук появился сразу, без перезапуска песни.
    const willMonitor = targets.includes('mic') && !targets.includes('spk');
    const total = targets.length + (targets.includes('spk') ? 0 : (willMonitor ? 1 : 0));
    let onendFired = false;

    const makeSource = (chain, viaMon) => {
      const out = viaMon ? chain.monGain : chain.master;
      if (!out) return null;
      const ctx = chain.ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (rate !== 1) src.playbackRate.value = rate;
      src.loop = !!opts.loop;
      const g = ctx.createGain();
      applyFade(g, opts.fadeIn || 0, opts.loop ? 0 : (opts.fadeOut || 0), buf.duration, vol);
      src.connect(g);
      g.connect(out);
      // «425 База»: короткий щелчок-треск рации в начале звука
      if (this.fartLevel === 4) {
        const nb = this.radioNoise(ctx);
        if (nb) {
          const ns = ctx.createBufferSource();
          ns.buffer = nb;
          const ng = ctx.createGain();
          const t = ctx.currentTime;
          ng.gain.setValueAtTime(0.0001, t);
          ng.gain.exponentialRampToValueAtTime(0.05, t + 0.015);
          ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
          ns.connect(ng);
          ng.connect(out);
          ns.start(t);
          ns.stop(t + 0.42);
        }
      }
      src.start(0, offset > 0 ? offset : 0, src.loop ? undefined : buf.duration / rate);
      src.onended = () => {
        group.ended++;
        if (group.ended >= total && !onendFired) {
          onendFired = true;
          this.live.delete(group);
          if (opts.onend) opts.onend();
        }
      };
      return { src, g };
    };

    // mic -> кабель (собеседники), spk -> monGain (твои динамики, громкость «Мне»)
    for (const t of targets) {
      if (t === 'mic') nodes.mic = makeSource(this.micCtx, false);
      else if (this.spkCtx && this.spkCtx.monGain) nodes.spk = makeSource(this.spkCtx, true);
    }
    // «слышу себя» для микрофонных звуков
    if (willMonitor && this.spkCtx && this.spkCtx.monGain) nodes.monspk = makeSource(this.spkCtx, true);

    // voice activation: short blip into mic before sound
    if (this.voiceActivation && targets.includes('mic')) this.blip();

    if (!Object.keys(nodes).length) return null;
    this.live.add(group);
    this.active.set(sound.id, nodes);
    return {
      id: sound.id,
      stop: () => this.stop(sound.id),
      setVolume: (v) => {
        for (const k in nodes) { try { nodes[k].g.gain.value = (typeof v === 'number' ? v : 1) * (this.normGain.get(sound.path) || 1); } catch {} }
      }
    };
  }

  stop(id) {
    for (const group of [...this.live]) {
      if (group.id !== id) continue;
      this._kill(group);
      this.live.delete(group);
    }
    this.active.delete(id);
  }

  stopAll() {
    for (const group of [...this.live]) this._kill(group);
    this.live.clear();
    this.active.clear();
  }

  isPlaying(id) {
    for (const group of this.live) if (group.id === id) return true;
    return false;
  }

  _kill(group) {
    for (const k in group.nodes) {
      try { group.nodes[k].src.stop(); } catch {}
    }
  }

  // белый шум коротким куском — треск рации
  radioNoise(ctx) {
    try {
      if (this._radioBuf && this._radioRate === ctx.sampleRate) return this._radioBuf;
      const len = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 1337;
      for (let i = 0; i < len; i++) {
        // простой ПСЧ-генератор: шум без зависимости от Math.random
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        d[i] = (seed / 0x7fffffff) * 2 - 1;
      }
      this._radioBuf = buf;
      this._radioRate = ctx.sampleRate;
      return buf;
    } catch { return null; }
  }

  blip() {
    const ctx = this.micCtx.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(g); g.connect(this.micCtx.master);
    osc.start(t); osc.stop(t + 0.05);
  }
}

function applyFade(gain, fadeIn, fadeOut, duration, vol) {
  const peak = vol != null && vol > 0 ? vol : 1;
  if (!fadeIn && !fadeOut) { gain.gain.value = peak; return; }
  const t = gain.context.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  if (fadeIn) gain.gain.linearRampToValueAtTime(peak, t + fadeIn);
  else gain.gain.setValueAtTime(peak, t);
  if (fadeOut) {
    const end = t + Math.max(duration, 0.05);
    gain.gain.setValueAtTime(peak, Math.max(t, end - fadeOut));
    gain.gain.linearRampToValueAtTime(0.0001, end);
  }
}

window.AudioEngine = AudioEngine;