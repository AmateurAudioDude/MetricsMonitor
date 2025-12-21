///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-signalmeter.js		     		 (V1.4)  //
//                                                           //
//  by Highpoint               last update: 20.12.2025       //
//                                                           //
//  Thanks for support by                                    //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude      //
//                                                           //
//  https://github.com/Highpoint2000/metricsmonitor          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {
const MODULE_SEQUENCE = [1,2,0,3,4];    // Do not touch - this value is automatically updated via the config file
const CANVAS_SEQUENCE = [4,2];    // Do not touch - this value is automatically updated via the config file
const sampleRate = 48000;    // Do not touch - this value is automatically updated via the config file
const MPXboost = 0;    // Do not touch - this value is automatically updated via the config file
const MPXmode = "off";    // Do not touch - this value is automatically updated via the config file
const MPXStereoDecoder = "off";    // Do not touch - this value is automatically updated via the config file
const MPXInputCard = "";    // Do not touch - this value is automatically updated via the config file
const fftLibrary = "fft-js";    // Do not touch - this value is automatically updated via the config file
const fftSize = 1024;    // Do not touch - this value is automatically updated via the config file
const SpectrumAttackLevel = 3;    // Do not touch - this value is automatically updated via the config file
const SpectrumDecayLevel = 15;    // Do not touch - this value is automatically updated via the config file
const minSendIntervalMs = 30;    // Do not touch - this value is automatically updated via the config file
const pilotCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const mpxCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const rdsCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const CurveYOffset = -40;    // Do not touch - this value is automatically updated via the config file
const CurveYDynamics = 1.9;    // Do not touch - this value is automatically updated via the config file
const stereoBoost = 1;    // Do not touch - this value is automatically updated via the config file
const eqBoost = 1;    // Do not touch - this value is automatically updated via the config file
const LockVolumeSlider = true;    // Do not touch - this value is automatically updated via the config file
const EnableSpectrumOnLoad = false;    // Do not touch - this value is automatically updated via the config file

// Configuration constants - updated automatically via config file
  const CONFIG = (window.MetricsMonitor && window.MetricsMonitor.Config) ? window.MetricsMonitor.Config : {};

  // -------------------------------------------------------
  // Utility Functions
  // -------------------------------------------------------
  const HUB_KEY = '__MM_SIGNALMETER_HUB__';
  const cssEscape = (s) => {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
    } catch {}
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, '\\$&');
  };
  const uid = (prefix = 'mm-sigm-') => `${prefix}${Math.random().toString(36).slice(2, 10)}`;

  // -------------------------------------------------------
  // Unit Conversion
  // -------------------------------------------------------
  function hfBaseToDisplay(unit, baseHF) {
    const ssu = (unit || '').toLowerCase();
    const v = Number(baseHF);
    if (!isFinite(v)) return 0;
    if (ssu === 'dbuv' || ssu === 'dbµv' || ssu === 'dbμv') return v - 10.875;
    if (ssu === 'dbm') return v - 119.75;
    return v; // default dBf
  }

  function hfPercentFromBase(baseHF) {
    const v = Number(baseHF);
    if (!isFinite(v)) return 0;
    let dBuV = v - 10.875;
    if (isNaN(dBuV)) dBuV = 0;
    const clamped = Math.max(0, Math.min(90, dBuV));
    return (clamped / 90) * 100;
  }

  function buildHFScale(unit) {
    const baseScale_dBuV = [90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
    const ssu = (unit || '').toLowerCase();
    const lastIndex = baseScale_dBuV.length - 1;

    const round10 = (v) => Math.round(v / 10) * 10;

    if (ssu === 'dbm') {
      return baseScale_dBuV.map((v, idx) => {
        const dBm = v - 108.875;
        const rounded = round10(dBm);
        return idx === lastIndex ? `${rounded} dBm` : `${rounded}`;
      });
    }
    if (ssu === 'dbf') {
      return baseScale_dBuV.map((v, idx) => {
        const dBf = v + 10.875;
        const rounded = round10(dBf);
        return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
      });
    }
    // default: dBµV
    return baseScale_dBuV.map((v, idx) => {
      const rounded = round10(v);
      return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
    });
  }

  // -------------------------------------------------------
  // Meter Drawing Helpers (scoped to a root element)
  // -------------------------------------------------------
  function stereoColorForPercent(p, totalSegments = 30) {
    const i = Math.max(0, Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1));
    const topBandStart = totalSegments - 5;
    if (i >= topBandStart) {
      const red = Math.round((i / 10) * 125);
      return `rgb(${red},0,0)`;
    }
    const green = 100 + Math.round((i / totalSegments) * 155);
    return `rgb(0,${green},0)`;
  }

  function updatePeakValue(peaks, channel, current, holdMs, smoothing) {
    const p = peaks[channel];
    if (!p) return;
    const now = Date.now();
    if (current > p.value) {
      p.value = current;
      p.lastUpdate = now;
    } else if (now - p.lastUpdate > holdMs) {
      p.value = p.value * smoothing;
      if (p.value < 0.5) p.value = 0;
    }
  }

  function setPeakSegment(meterEl, peak, meterId) {
    const segments = meterEl.querySelectorAll('.segment');
    if (!segments.length) return;
    const prev = meterEl.querySelector('.segment.peak-flag');
    if (prev) prev.classList.remove('peak-flag');

    const idx = Math.max(0, Math.min(segments.length - 1, Math.round((peak / 100) * segments.length) - 1));
    const seg = segments[idx];
    if (!seg) return;

    seg.classList.add('peak-flag');
    if (meterId && (meterId.includes('left') || meterId.includes('right'))) {
      seg.style.backgroundColor = stereoColorForPercent(peak, segments.length);
    }
  }

  function updateMeterById(root, meterId, level, peaks, peakCfg) {
    if (!root) return;
    const meter = root.querySelector(`#${cssEscape(meterId)}`);
    if (!meter) return;

    const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
    const segments = meter.querySelectorAll('.segment');
    const activeCount = Math.round((safeLevel / 100) * segments.length);

    segments.forEach((seg, i) => {
      if (i < activeCount) {
        if (meterId.includes('left') || meterId.includes('right')) {
          if (i >= segments.length - 5) {
            const red = Math.round((i / 10) * 125);
            seg.style.backgroundColor = `rgb(${red},0,0)`;
          } else {
            const green = 100 + Math.round((i / segments.length) * 155);
            seg.style.backgroundColor = `rgb(0,${green},0)`;
          }
        } else if (meterId.includes('hf')) {
          const hfThresholdIndex = Math.round((20 / 90) * segments.length);
          if (i < hfThresholdIndex) {
            const pos = i / hfThresholdIndex;
            const red = 150 + Math.round(pos * 185);
            seg.style.backgroundColor = `rgb(${red},0,0)`;
          } else {
            const green = 100 + Math.round((i / segments.length) * 155);
            seg.style.backgroundColor = `rgb(0,${green},0)`;
          }
        } else {
          seg.style.backgroundColor = '#333';
        }
      } else {
        // Ensure inactive segments are visible as dark gray
        seg.style.backgroundColor = '#333';
      }
    });

    // Peak marker only for stereo
    if (meterId.includes('left') || meterId.includes('right')) {
      const key = meterId.includes('left') ? 'left' : 'right';
      updatePeakValue(peaks, key, safeLevel, peakCfg.holdMs, peakCfg.smoothing);
      setPeakSegment(meter, peaks[key].value, meterId);
    }
  }

  // -------------------------------------------------------
  // Shared Hub (Single Socket + Single Audio Loop)
  // -------------------------------------------------------
  function createHub() {
    return {
      socket: null,
      connected: false,
      connecting: null,
      msgListenerAttached: false,

      // Registered instances (key -> instance)
      instances: new Map(), 

      // Latest values (for late joiners)
      latestSigBase: null,
      unit: (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === 'function')
        ? (window.MetricsMonitor.getSignalUnit() || 'dbf').toLowerCase()
        : (localStorage.getItem('mm_signal_unit') || 'dbf').toLowerCase(),

      // Shared exported levels
      sharedLevels: {
        hf: 0,
        hfValue: 0,
        hfBase: 0,
        left: 0,
        right: 0
      },

      ensureConnected() {
        if (this.connected) return Promise.resolve(this.socket);
        if (this.connecting) return this.connecting;

        this.connecting = (async () => {
          // Wait for socketPromise availability
          while (!window.socketPromise) {
            await new Promise(r => setTimeout(r, 400));
          }
          const ws = await window.socketPromise;
          if (!ws) return null;
          this.socket = ws;

          if (!this.msgListenerAttached) {
            this.msgListenerAttached = true;
            ws.addEventListener('message', (evt) => {
              try {
                const msg = JSON.parse(evt.data);
                if (msg && msg.sig !== undefined) {
                  this.broadcastSig(msg.sig);
                }
              } catch {}
            });
          }

          this.connected = true;
          return ws;
        })().finally(() => {
          // Promise cleanup
        });

        return this.connecting;
      },

      broadcastSig(baseValue) {
        const v = Number(baseValue);
        if (!isFinite(v)) return;
        this.latestSigBase = v;
        for (const inst of this.instances.values()) {
          try { inst._onSig(v); } catch {}
        }
      },

      setUnit(unit) {
        if (!unit) return;
        const u = String(unit).toLowerCase();
        this.unit = u;
        for (const inst of this.instances.values()) {
          try { inst._onUnit(u); } catch {}
        }
      },

      // -----------------------
      // Shared Audio Analyser
      // -----------------------
      audio: {
        ctx: null,
        sourceNode: null,
        splitter: null,
        analyserL: null,
        analyserR: null,
        dataL: null,
        dataR: null,
        rafId: null,
        setupIntervalId: null,
        subscribers: new Set(), // instances
      },

      ensureAudio() {
        const A = this.audio;
        if (A.setupIntervalId) return;

        const trySetup = () => {
          if (!window.Stream || !Stream.Fallback || !Stream.Fallback.Player || !Stream.Fallback.Player.Amplification) return;
          const player = Stream.Fallback.Player;
          const sourceNode = player.Amplification;
          if (!sourceNode || !sourceNode.context) return;

          const ctx = sourceNode.context;
          if (A.ctx !== ctx) {
            A.ctx = ctx;
            A.splitter = null;
            A.analyserL = null;
            A.analyserR = null;
            A.dataL = null;
            A.dataR = null;
            A.sourceNode = null;
          }
          A.sourceNode = sourceNode;

          if (!A.splitter) {
            try {
              A.splitter = ctx.createChannelSplitter(2);
              A.analyserL = ctx.createAnalyser();
              A.analyserR = ctx.createAnalyser();
              A.analyserL.fftSize = 2048;
              A.analyserR.fftSize = 2048;
              A.dataL = new Uint8Array(A.analyserL.frequencyBinCount);
              A.dataR = new Uint8Array(A.analyserR.frequencyBinCount);

              // Connect nodes (ignore if already connected)
              try { sourceNode.connect(A.splitter); } catch {}
              try { A.splitter.connect(A.analyserL, 0); } catch {}
              try { A.splitter.connect(A.analyserR, 1); } catch {}
            } catch (e) {
              // Retry on failure
              return;
            }
          }

          // Start RAF loop
          if (!A.rafId) {
            const loop = () => {
              try {
                if (A.analyserL && A.analyserR && A.dataL && A.dataR) {
                  A.analyserL.getByteTimeDomainData(A.dataL);
                  A.analyserR.getByteTimeDomainData(A.dataR);
                  let maxL = 0;
                  let maxR = 0;
                  for (let i = 0; i < A.dataL.length; i++) {
                    const d = Math.abs(A.dataL[i] - 128);
                    if (d > maxL) maxL = d;
                  }
                  for (let i = 0; i < A.dataR.length; i++) {
                    const d = Math.abs(A.dataR[i] - 128);
                    if (d > maxR) maxR = d;
                  }
                  const sBoost = (window.MetricsMonitor && window.MetricsMonitor.Config)
                    ? (window.MetricsMonitor.Config.stereoBoost ?? 4)
                    : 4;
                  let levelL = ((maxL / 128) * 100) * sBoost;
                  let levelR = ((maxR / 128) * 100) * sBoost;
                  levelL = Math.min(100, Math.max(0, levelL));
                  levelR = Math.min(100, Math.max(0, levelR));

                  this.sharedLevels.left = levelL;
                  this.sharedLevels.right = levelR;

                  for (const inst of A.subscribers) {
                    try { inst._onAudio(levelL, levelR); } catch {}
                  }
                }
              } catch {}
              A.rafId = requestAnimationFrame(loop);
            };
            A.rafId = requestAnimationFrame(loop);
          }
        };

        // Poll for stream availability
        A.setupIntervalId = setInterval(trySetup, 1200);
        trySetup();
      }
    };
  }

  const HUB = window[HUB_KEY] || (window[HUB_KEY] = createHub());

  // Synchronize hub with global unit changes
  if (!HUB._unitListenerAttached && window.MetricsMonitor && typeof window.MetricsMonitor.onSignalUnitChange === 'function') {
    HUB._unitListenerAttached = true;
    window.MetricsMonitor.onSignalUnitChange((u) => HUB.setUnit(u));
    // Initialize once
    try {
      if (window.MetricsMonitor.getSignalUnit) HUB.setUnit(window.MetricsMonitor.getSignalUnit());
    } catch {}
  }

  // -------------------------------------------------------
  // Instance Factory
  // -------------------------------------------------------
  function createInstance(containerOrEl = 'level-meter-container', opts = {}) {
    const root = (typeof containerOrEl === 'string')
      ? document.getElementById(containerOrEl)
      : containerOrEl;
    if (!root) return null;

    const instanceKey = String(opts.instanceKey || uid());
    const bindExisting = !!opts.bindExisting;
    const textOnly = !!opts.textOnly;
    const useLegacyIds = opts.useLegacyIds !== undefined ? !!opts.useLegacyIds : true;
    const enableAudio = opts.enableAudio !== undefined ? !!opts.enableAudio : (!textOnly);

    // Destroy existing instance if key collision
    if (HUB.instances.has(instanceKey)) {
      try { HUB.instances.get(instanceKey).destroy(); } catch {}
      HUB.instances.delete(instanceKey);
    }

    const PEAK_CONFIG = { smoothing: 0.85, holdMs: 5000 };
    const peaks = {
      left: { value: 0, lastUpdate: Date.now() },
      right: { value: 0, lastUpdate: Date.now() }
    };

    const state = {
      hfUnit: (HUB.unit || 'dbf').toLowerCase(),
      highestSignal: -Infinity,
      levels: {
        hf: 0,
        hfValue: 0,
        hfBase: 0,
        left: 0,
        right: 0
      },
      ids: {
        left: 'left-meter',
        right: 'right-meter',
        hf: 'hf-meter'
      }
    };

    // DOM Bindings
    const dom = {
      root,
      elHighest: null,
      elMain: null,
      elDec: null,
      unitEls: [],
      meterExists: false,
    };

    function bindTextElements() {
      // Prioritize data attributes for embedded/canvas usage
      dom.elHighest = root.querySelector('[data-mm-signal="highest"]') || root.querySelector('#data-signal-highest');
      dom.elMain = root.querySelector('[data-mm-signal="main"]') || root.querySelector('#data-signal');
      dom.elDec = root.querySelector('[data-mm-signal="decimal"]') || root.querySelector('#data-signal-decimal');
      dom.unitEls = Array.from(root.querySelectorAll('.signal-units'));
    }

    function createLevelMeter(id, label, container, scaleValues) {
      const levelMeter = document.createElement('div');
      levelMeter.classList.add('signal-level-meter');

      const top = document.createElement('div');
      top.classList.add('meter-top');

      const meterBar = document.createElement('div');
      meterBar.classList.add('signal-meter-bar');
      meterBar.setAttribute('id', id);

      for (let i = 0; i < 30; i++) {
        const segment = document.createElement('div');
        segment.classList.add('segment');
        // Set initial background color
        segment.style.backgroundColor = '#333'; 
        meterBar.appendChild(segment);
      }
      if (id.includes('left') || id.includes('right')) {
        const marker = document.createElement('div');
        marker.className = 'peak-marker';
        meterBar.appendChild(marker);
      }

      const labelElement = document.createElement('div');
      labelElement.classList.add('label');
      labelElement.innerText = label;

      const meterWrapper = document.createElement('div');
      meterWrapper.classList.add('meter-wrapper');
      if (id.includes('left')) labelElement.classList.add('label-left');
      if (id.includes('right')) labelElement.classList.add('label-right');
      meterWrapper.appendChild(meterBar);
      meterWrapper.appendChild(labelElement);

      if (scaleValues && scaleValues.length > 0) {
        const scale = document.createElement('div');
        scale.classList.add('signal-meter-scale');
        scaleValues.forEach((v) => {
          const tick = document.createElement('div');
          tick.innerText = v;
          scale.appendChild(tick);
        });
        top.appendChild(scale);
      }

      top.appendChild(meterWrapper);
      levelMeter.appendChild(top);
      container.appendChild(levelMeter);
    }

    function buildUiFull() {
      // Use legacy IDs by default for CSS compatibility
      const idPrefix = useLegacyIds ? '' : `${instanceKey}-`;
      state.ids.left = idPrefix + 'left-meter';
      state.ids.right = idPrefix + 'right-meter';
      state.ids.hf = idPrefix + 'hf-meter';

      root.innerHTML = '';

      // Stereo Group
      const stereoGroup = document.createElement('div');
      stereoGroup.classList.add('stereo-group');

      const stereoScale = ['+5 dB', '0', '-5', '-10', '-15', '-20', '-25', '-30', '-35 dB'];
      createLevelMeter(state.ids.left, 'LEFT', stereoGroup, stereoScale);
      createLevelMeter(state.ids.right, 'RIGHT', stereoGroup, []);
      root.appendChild(stereoGroup);

      // HF Meter
      const hfScale = buildHFScale(state.hfUnit);
      createLevelMeter(state.ids.hf, 'RF', root, hfScale);
      const hfLevelMeter = root.querySelector(`#${cssEscape(state.ids.hf)}`)?.closest('.signal-level-meter');
      if (hfLevelMeter) hfLevelMeter.style.transform = 'translateX(-5px)';

      // Signal Panel
      const signalPanel = document.createElement('div');
      signalPanel.className = 'panel-33 no-bg-phone signal-panel-layout';
      // Use legacy IDs if requested, otherwise data attributes
      if (useLegacyIds) {
        signalPanel.innerHTML = `
          <h2 class="signal-heading">SIGNAL</h2>
          <div class="text-small text-gray highest-signal-container">
            <i class="fa-solid fa-arrow-up"></i>
            <span id="data-signal-highest"></span>
            <span class="signal-units"></span>
          </div>
          <div class="text-big">
            <span id="data-signal"></span><!--
         --><span id="data-signal-decimal" class="text-medium-big" style="opacity:0.7;"></span>
            <span class="signal-units text-medium">dBf</span>
          </div>
        `;
      } else {
        signalPanel.innerHTML = `
          <h2 class="signal-heading">SIGNAL</h2>
          <div class="text-small text-gray highest-signal-container">
            <i class="fa-solid fa-arrow-up"></i>
            <span data-mm-signal="highest"></span>
            <span class="signal-units"></span>
          </div>
          <div class="text-big">
            <span data-mm-signal="main"></span><!--
         --><span data-mm-signal="decimal" class="text-medium-big" style="opacity:0.7;"></span>
            <span class="signal-units text-medium">dBf</span>
          </div>
        `;
      }
      root.appendChild(signalPanel);

      dom.meterExists = true;
      bindTextElements();
    }

    // Build or bind
    if (bindExisting) {
      bindTextElements();
      dom.meterExists = !!root.querySelector('.signal-meter-bar');
    } else if (!textOnly) {
      buildUiFull();
    } else {
      // textOnly without bindExisting: simply bind elements
      bindTextElements();
    }

    // Instance Methods
    const instance = {
      key: instanceKey,
      root,
      opts: { bindExisting, textOnly, useLegacyIds, enableAudio },
      state,

      destroy() {
        // Unsubscribe from Hub
        HUB.instances.delete(instanceKey);
        HUB.audio.subscribers.delete(instance);
      },

      _onUnit(unit) {
        state.hfUnit = String(unit || 'dbf').toLowerCase();
        state.highestSignal = -Infinity;

        // Reset highest display
        if (dom.elHighest) dom.elHighest.textContent = '---';

        // Update unit text in this root
        if (dom.unitEls && dom.unitEls.length) {
          dom.unitEls.forEach(span => { span.textContent = state.hfUnit; });
        }

        // Update HF scale if meter exists
        if (dom.meterExists) {
          const meterEl = root.querySelector(`#${cssEscape(state.ids.hf)}`) || root.querySelector('#hf-meter');
          const levelMeter = meterEl?.closest('.signal-level-meter');
          const scaleEl = levelMeter?.querySelector('.signal-meter-scale');
          if (scaleEl) {
            const newScale = buildHFScale(state.hfUnit);
            const ticks = scaleEl.querySelectorAll('div');
            newScale.forEach((txt, idx) => { if (ticks[idx]) ticks[idx].innerText = txt; });
          }
        }

        // Re-apply last value
        if (typeof state.levels.hfBase === 'number' && isFinite(state.levels.hfBase) && HUB.latestSigBase !== null) {
          instance._onSig(HUB.latestSigBase);
        }
      },

      _onSig(baseValue) {
        // Display correction
        const correction = 0;
        const correctedBase = Number(baseValue) + correction;
        if (!isFinite(correctedBase)) return;

        state.levels.hfBase = correctedBase;
        const displayHF = hfBaseToDisplay(state.hfUnit, correctedBase);
        state.levels.hfValue = displayHF;

        // Export shared levels
        HUB.sharedLevels.hfBase = correctedBase;
        HUB.sharedLevels.hfValue = displayHF;

        // Update Highest Signal
        if (displayHF > state.highestSignal) {
          state.highestSignal = displayHF;
          if (dom.elHighest) dom.elHighest.textContent = state.highestSignal.toFixed(1);
        }

        // Update Main Text
        if (dom.elMain) {
          const parts = displayHF.toFixed(1).split('.');
          dom.elMain.textContent = parts[0];
          if (dom.elDec && parts[1]) dom.elDec.textContent = '.' + parts[1];
        }

        // Update HF Bar
        const percent = hfPercentFromBase(correctedBase);
        state.levels.hf = percent;
        HUB.sharedLevels.hf = percent;
        if (dom.meterExists && !textOnly) {
          updateMeterById(root, state.ids.hf, percent, peaks, PEAK_CONFIG);
        }
      },

      _onAudio(levelL, levelR) {
        if (!dom.meterExists || textOnly) return;
        state.levels.left = levelL;
        state.levels.right = levelR;

        updateMeterById(root, state.ids.left, levelL, peaks, PEAK_CONFIG);
        updateMeterById(root, state.ids.right, levelR, peaks, PEAK_CONFIG);
      }
    };

    // Register instance
    HUB.instances.set(instanceKey, instance);

    // Initialize unit for instance
    instance._onUnit(HUB.unit);

    // Subscribe to audio if required
    if (enableAudio && !textOnly) {
      HUB.audio.subscribers.add(instance);
      HUB.ensureAudio();
    }

    // Connect socket and apply last values
    if (opts.autoConnect !== false) {
      HUB.ensureConnected();
    }
    if (HUB.latestSigBase !== null) {
      instance._onSig(HUB.latestSigBase);
    }
    // Apply latest audio levels
    if (HUB.sharedLevels.left || HUB.sharedLevels.right) {
      instance._onAudio(HUB.sharedLevels.left, HUB.sharedLevels.right);
    }

    return instance;
  }

  // -------------------------------------------------------
  // Public API (Backwards Compatible)
  // -------------------------------------------------------
  let defaultInstance = null;

  window.MetricsSignalMeter = {
    // Legacy entry point for panel mode
    init(containerOrId = 'level-meter-container') {
      defaultInstance = createInstance(containerOrId, {
        instanceKey: 'panel',
        bindExisting: false,
        textOnly: false,
        useLegacyIds: true,
        enableAudio: true,
        autoConnect: true
      });
      return defaultInstance;
    },

    // New multi-instance support
    createInstance,

    destroyInstance(instanceKey) {
      const key = String(instanceKey || '');
      const inst = HUB.instances.get(key);
      if (inst) inst.destroy();
    },

    // Headless start for data listener
    startDataListener() {
      HUB.ensureConnected();
    },

    // Backwards compatibility: Broadcast signal value
    setHF(baseValue) {
      HUB.broadcastSig(baseValue);
    },

    // Backwards compatibility: Set unit locally
    setHFUnit(unit) {
      HUB.setUnit(unit);
    },

    // Expose shared levels
    levels: HUB.sharedLevels,

    // Backwards compatibility helper
    updateMeter(meterId, level) {
      if (defaultInstance) {
        try {
          updateMeterById(defaultInstance.root, meterId, level,
            { left: { value: 0, lastUpdate: Date.now() }, right: { value: 0, lastUpdate: Date.now() } },
            { smoothing: 0.85, holdMs: 5000 }
          );
        } catch {}
      }
    }
  };

})();