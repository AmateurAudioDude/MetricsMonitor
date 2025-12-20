///////////////////////////////////////////////////////////////
/// Level Meters + Audio (Browser) + MPX WebSocket          ///
///////////////////////////////////////////////////////////////

(() => {
const sampleRate = 48000;    // Do not touch - this value is automatically updated via the config file
const stereoBoost = 1;    // Do not touch - this value is automatically updated via the config file
const eqBoost = 1;    // Do not touch - this value is automatically updated via the config file
const fftSize = 512;    // Do not touch - this value is automatically updated via the config file
const SpectrumAverageLevel = 15;    // Do not touch - this value is automatically updated via the config file
const minSendIntervalMs = 30;    // Do not touch - this value is automatically updated via the config file
const pilotCalibration = 2;    // Do not touch - this value is automatically updated via the config file
const mpxCalibration = 54;    // Do not touch - this value is automatically updated via the config file
const rdsCalibration = 1.25;    // Do not touch - this value is automatically updated via the config file
const CurveYOffset = -40;    // Do not touch - this value is automatically updated via the config file
const CurveYDynamics = 1.9;    // Do not touch - this value is automatically updated via the config file
const MPXmode = "auto";    // Do not touch - this value is automatically updated via the config file
const MPXStereoDecoder = "off";    // Do not touch - this value is automatically updated via the config file
const MPXInputCard = "";    // Do not touch - this value is automatically updated via the config file
const LockVolumeSlider = true;    // Do not touch - this value is automatically updated via the config file
  
  ///////////////////////////////////////////////////////////////
  // Custom Styles for value display
  ///////////////////////////////////////////////////////////////
  const style = document.createElement('style');
  style.innerHTML = `
    /* Werte-Anzeige über dem Balken */
    .value-display {
      text-align: center;
      font-size: 10px !important;   /* Gleiche Größe wie Labels */
      line-height: 12px;
      height: 12px;
      color: #ddd;
      font-family: inherit;
      margin-bottom: 2px;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  ///////////////////////////////////////////////////////////////

  // Feature flags depending on MPX sample rate
  const RDS_ENABLED   = (sampleRate === 192000);
  const PILOT_ENABLED = (sampleRate !== 48000);
  const MPX_ENABLED   = (sampleRate === 192000);

  // Global level values
  const levels = {
    left: 0,
    right: 0,
    hf: 0,
    hfBase: 0,
    hfValue: 0,
    stereoPilot: 0,
    rds: 0,
    mpxTotal: 0
  };

  // Gating Flags controlled via WebSocket (Public API)
  let websocketStereoActive = false; // Controlled by message.st
  let websocketRdsActive = false;    // Controlled by message.rds

  // Peak-hold configuration
  const PEAK_CONFIG = {
    smoothing: 0.85,
    holdMs: 5000
  };

  const peaks = {
    left:  { value: 0, lastUpdate: Date.now() },
    right: { value: 0, lastUpdate: Date.now() }
  };

  // --- MPX / Spectrum data ------------------------------------------
  let mpxSpectrum = [];
  let mpxSmoothSpectrum = [];

  const MPX_DB_MIN   = -90;
  const MPX_DB_MAX   = 0;
  const MPX_FMAX     = 96000;
  const MPX_AVG      = 6;

  // Soft-smoothing
  let pilotSmooth    = 0;
  let rdsShortPrev   = 0;
  let rdsLongPrev    = 0;
  let mpxTotalSmooth = 0;

  // RDS lock state
  let rdsLocked    = false;
  let rdsLockTimer = 18;

  function dbToAmp(db) {
    return Math.pow(10, db / 20);
  }

  function bandPower(centerHz, bandHz) {
    if (!mpxSpectrum.length) return 0;

    const N       = mpxSpectrum.length;
    const maxFreq = MPX_FMAX;

    const fMin = centerHz - bandHz / 2;
    const fMax = centerHz + bandHz / 2;

    const idxMin = Math.max(0, Math.floor((fMin / maxFreq) * (N - 1)));
    const idxMax = Math.min(N - 1, Math.ceil((fMax / maxFreq) * (N - 1)));
    if (idxMax <= idxMin) return 0;

    let p = 0;
    for (let i = idxMin; i <= idxMax; i++) {
      const db = mpxSpectrum[i];
      if (!isFinite(db) || db < MPX_DB_MIN) continue;
      const a = dbToAmp(db);
      p += a * a;
    }
    return p;
  }

  // --- RF unit handling ---------------------------------------------
  let hfUnit = "dbf";
  let hfUnitListenerAttached = false;

  if (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === "function") {
    const u = window.MetricsMonitor.getSignalUnit();
    if (u) {
      hfUnit = u.toLowerCase();
    }
  }

  function hfBaseToDisplay(baseHF) {
    const v = Number(baseHF);
    if (!isFinite(v)) return 0;
    const ssu = (hfUnit || "").toLowerCase();

    if (ssu === "dbuv" || ssu === "dbµv" || ssu === "dbμv") {
      return v - 10.875;
    } else if (ssu === "dbm") {
      return v - 119.75;
    } else if (ssu === "dbf") {
      return v;
    }
    return v;
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
    const ssu = (unit || hfUnit || "").toLowerCase();

    function round10(v) {
      return Math.round(v / 10) * 10;
    }

    const lastIndex = baseScale_dBuV.length - 1;

    if (ssu === "dbm") {
      return baseScale_dBuV.map((v, idx) => {
        const dBm = v - 108.875;
        const rounded = round10(dBm);
        // Einheit nur beim letzten Element (0) hinzufügen
        return idx === lastIndex ? `${rounded} dBm` : `${rounded}`;
      });
    }

    if (ssu === "dbf") {
      return baseScale_dBuV.map((v, idx) => {
        const dBf = v + 10.875
        const rounded = round10(dBf);
        // Einheit nur beim letzten Element (0) hinzufügen
        return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
      });
    }

    // Default: dBµV
    return baseScale_dBuV.map((v, idx) => {
      const rounded = round10(v);
      // Einheit nur beim letzten Element (0) hinzufügen
      return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
    });
  }

  // --- Stereo audio directly from browser ---------------------------
  let stereoAudioContext    = null;
  let stereoSourceNode      = null;
  let stereoSplitter        = null;
  let stereoAnalyserL       = null;
  let stereoAnalyserR       = null;
  let stereoDataL           = null;
  let stereoDataR           = null;
  let stereoAnimationId     = null;
  let stereoSetupIntervalId = null;

  function stereoColorForPercent(p, totalSegments = 30) {
    const i = Math.max(
      0,
      Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1)
    );
    const topBandStart = totalSegments - 5;
    if (i >= topBandStart) {
      const red = Math.round((i / 10) * 125);
      return `rgb(${red},0,0)`;
    } else {
      const green = 100 + Math.round((i / totalSegments) * 155);
      return `rgb(0,${green},0)`;
    }
  }

  const scales = {
    left: ["+5,0 dB","0,0","-5,0","-10,0","-15,0","-20,0","-25,0","-30,0","-35,0 dB"],
    right: [],
    // Changed scale to be linear: 16, 14, 12 ... 0
    stereoPilot: ["16,0","14,0","12,0","10,0","8,0","6,0","4,0","2,0","0 kHz"],
    hf: [],
    rds: ["10,0","9,0","8,0","7,0","6,0","5,0","4,0","3,0","2,0","1,0","0 kHz"],
    mpx: ["120,0","105,0","90,0","75,0","60,0","45,0","30,0","15,0","0 kHz"]
  };

  function updatePeakValue(channel, current) {
    const p = peaks[channel];
    if (!p) return;
    const now = Date.now();
    if (current > p.value) {
      p.value = current;
      p.lastUpdate = now;
    } else if (now - p.lastUpdate > PEAK_CONFIG.holdMs) {
      p.value = p.value * PEAK_CONFIG.smoothing;
      if (p.value < 0.5) p.value = 0;
    }
  }

  function setPeakSegment(meterEl, peak, meterId) {
    const segments = meterEl.querySelectorAll(".segment");
    if (!segments.length) return;

    const prev = meterEl.querySelector(".segment.peak-flag");
    if (prev) prev.classList.remove("peak-flag");

    const idx = Math.max(
      0,
      Math.min(segments.length - 1, Math.round((peak / 100) * segments.length) - 1)
    );
    const seg = segments[idx];
    if (!seg) return;

    seg.classList.add("peak-flag");

    if (meterId && (meterId.includes("left") || meterId.includes("right"))) {
      seg.style.backgroundColor = stereoColorForPercent(peak, segments.length);
    }
  }

  function createLevelMeter(id, label, container, scaleValues) {
    const levelMeter = document.createElement("div");
    levelMeter.classList.add("level-meter");

    const top = document.createElement("div");
    top.classList.add("meter-top");

    const meterBar = document.createElement("div");
    meterBar.classList.add("meter-bar");
    meterBar.setAttribute("id", id);

    for (let i = 0; i < 30; i++) {
      const segment = document.createElement("div");
      segment.classList.add("segment");
      meterBar.appendChild(segment);
    }

    if (id.includes("left") || id.includes("right")) {
      const marker = document.createElement("div");
      marker.className = "peak-marker";
      meterBar.appendChild(marker);
    }

    const labelElement = document.createElement("div");
    labelElement.classList.add("label");
    labelElement.innerText = label;

    const meterWrapper = document.createElement("div");
    meterWrapper.classList.add("meter-wrapper");

    // NEW: Add Value Display Element above Bar
    const valueDisplay = document.createElement("div");
    valueDisplay.classList.add("value-display");
    valueDisplay.innerText = "0.0";
    meterWrapper.appendChild(valueDisplay);

    if (id.includes("left"))  labelElement.classList.add("label-left");
    if (id.includes("right")) labelElement.classList.add("label-right");

    meterWrapper.appendChild(meterBar);
    meterWrapper.appendChild(labelElement);

    if (scaleValues && scaleValues.length > 0) {
      const scale = document.createElement("div");
      scale.classList.add("meter-scale");
      scaleValues.forEach((v) => {
        const tick = document.createElement("div");
        tick.innerText = v;
        scale.appendChild(tick);
      });
      top.appendChild(scale);
    }

    top.appendChild(meterWrapper);
    levelMeter.appendChild(top);
    container.appendChild(levelMeter);
  }

function updateMeter(meterId, level) {
    const meter = document.getElementById(meterId);
    if (!meter) return;

    const isRds   = meterId.includes("rds");
    const isPilot = meterId.includes("stereo-pilot");
    const isMpx   = meterId.includes("mpx");
    const isHf    = meterId.includes("hf");

    const rdsDisabled   = isRds   && !RDS_ENABLED;
    const pilotDisabled = isPilot && !PILOT_ENABLED;
    const mpxDisabled   = isMpx   && !MPX_ENABLED;

    const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
    const segments = meter.querySelectorAll(".segment");
    const activeCount = Math.round((safeLevel / 100) * segments.length);

    segments.forEach((seg, i) => {
      if (rdsDisabled || pilotDisabled || mpxDisabled) {
        seg.style.backgroundColor = "#333";
        return;
      }

      if (i < activeCount) {
        if (meterId.includes("left") || meterId.includes("right")) {
          if (i >= segments.length - 5) {
            const red = Math.round((i / 10) * 125);
            seg.style.backgroundColor = `rgb(${red},0,0)`;
          } else {
            const green = 100 + Math.round((i / segments.length) * 155);
            seg.style.backgroundColor = `rgb(0,${green},0)`;
          }
        } else if (isPilot) {
          if (i < segments.length * 0.5) {
            const green = 100 + Math.round((i / (segments.length * 0.5)) * 155);
            seg.style.backgroundColor = `rgb(0,${green},0)`;
          } else {
            const pos = (i - segments.length * 0.5) / (segments.length * 0.5);
            const red = 225 - Math.round(pos * 155);
            seg.style.backgroundColor = `rgb(${red},0,0)`;
          }
        } else if (isRds) {
          const rdsThresholdIndex1 = Math.round((2.5 / 10) * segments.length);
          const rdsThresholdIndex2 = Math.round((3.5 / 10) * segments.length);
          if (i < rdsThresholdIndex1) {
            const green = 100 + Math.round((i / (segments.length * 0.5)) * 225);
            seg.style.backgroundColor = `rgb(0,${green},0)`;
          } else if (i >= rdsThresholdIndex1 && i <= rdsThresholdIndex2) {
            const yellowIntensity = 255 - Math.round(
              (i - rdsThresholdIndex1) / (rdsThresholdIndex2 - rdsThresholdIndex1) * 60
            );
            seg.style.backgroundColor =
              `rgb(${yellowIntensity + 150}, ${yellowIntensity}, 0)`;
          } else {
            const pos = (i - rdsThresholdIndex2) / (segments.length - rdsThresholdIndex2);
            const red = 225 - Math.round(pos * 155);
            seg.style.backgroundColor = `rgb(${red},0,0)`;
          }
        } else if (isMpx) {
          const kHzMax       = 120;
          const idxGreenMax  = Math.round((75 / kHzMax) * segments.length);
          const idxYellowMax = Math.round((80 / kHzMax) * segments.length);
          if (i < idxGreenMax) {
            const green = 100 + Math.round((i / Math.max(1, idxGreenMax - 1)) * 155);
            seg.style.backgroundColor = `rgb(0,${green},0)`;
          } else if (i < idxYellowMax) {
            const pos = (i - idxGreenMax) / Math.max(1, idxYellowMax - idxGreenMax);
            const yellowIntensity = 255 - Math.round(pos * 60);
            seg.style.backgroundColor =
              `rgb(${yellowIntensity + 150}, ${yellowIntensity}, 0)`;
          } else {
            const pos = (i - idxYellowMax) / Math.max(1, segments.length - idxYellowMax);
            const red = 225 - Math.round(pos * 155);
            seg.style.backgroundColor = `rgb(${red},0,0)`;
          }
        } else if (isHf) {
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
          if (i < segments.length * 0.6) {
            seg.style.backgroundColor = "#4caf50";
          } else if (i < segments.length * 0.8) {
            seg.style.backgroundColor = "#ff9800";
          } else {
            seg.style.backgroundColor = "#f44336";
          }
        }
      } else {
        seg.style.backgroundColor = "#333";
      }
    });

    if (meterId.includes("left") || meterId.includes("right")) {
      const channel = meterId.includes("left") ? "left" : "right";
      updatePeakValue(channel, safeLevel);
      setPeakSegment(meter, peaks[channel].value, meterId);
    }
    
    const wrapper = meter.closest('.meter-wrapper');
    if (wrapper) {
      const valDisp = wrapper.querySelector('.value-display');
      if (valDisp) {
        let text = "";
        
        if (meterId.includes("left") || meterId.includes("right")) {
          const channel = meterId.includes("left") ? "left" : "right";
          const peakVal = peaks[channel].value;
          const dB = (peakVal / 100) * 40 - 35;
          text = dB.toFixed(1);

        } else if (isHf) {
           // ---- HIER IST DIE KORREKTUR ----
           const calibration = 0; // Wert um 1.2 anheben
           const dBuV = (safeLevel / 100) * 90;
           const baseHF = dBuV + 10.875 + calibration; // Kalibrierung hier hinzufügen
           const displayValue = hfBaseToDisplay(baseHF);
           text = displayValue.toFixed(1);
           // ---- ENDE DER KORREKTUR ----

        } else if (isPilot) {
           // HIER: Skala geht jetzt bis 16.0 kHz (wegen neuer Skaleneinteilung)
           const khz = (safeLevel / 100) * 16.0;
           text = khz.toFixed(1);

        } else if (isRds) {
           const khz = (safeLevel / 100) * 10.0;
           text = khz.toFixed(1);

        } else if (isMpx) {
           const khz = (safeLevel / 100) * 120.0;
           text = khz.toFixed(1);

        } else {
           text = safeLevel.toFixed(1);
        }

        if (rdsDisabled || pilotDisabled || mpxDisabled) {
             text = "-";
        }

        valDisp.innerText = text;
      }
    }
}

  // ---------------------------------------------------------------
  // Robust MPX data parsing (from FIX)
  // ---------------------------------------------------------------
  function handleMpxArray(data) {
    if (!data || (!Array.isArray(data) && !(data instanceof Float32Array) && !(data instanceof Uint8Array))) {
      return;
    }

    const mags = [];
    const dataLen = data.length;
    
    // NOTE: We do NOT modify the spectrum here anymore to ensure individual meters
    // don't get distorted by the "Physical vs Visual" boost mismatch.
    
    for (let i = 0; i < dataLen; i++) {
      const item = data[i];
      let mag = 0;

      if (typeof item === "number") {
        mag = item;
      }
      else if (item && typeof item === "object") {
        if (typeof item.m === "number") mag = item.m;
        else if (typeof item.mag === "number") mag = item.mag;
        else if (Array.isArray(item) && typeof item[0] === "number") {
           const re = item[0], im = item[1];
           mag = Math.sqrt(re * re + im * im);
        }
      }

      if (!isFinite(mag) || mag < 0) mag = 0;
      mags.push(mag);
    }

    const arr = [];
    for (let i = 0; i < mags.length; i++) {
      let db = 20 * Math.log10(mags[i] + 1e-15);
      if (db < MPX_DB_MIN) db = MPX_DB_MIN;
      if (db > MPX_DB_MAX) db = MPX_DB_MAX;
      arr.push(db);
    }

    if (mpxSmoothSpectrum.length === 0) {
      mpxSmoothSpectrum = arr.slice();
    } else {
      const len = Math.min(arr.length, mpxSmoothSpectrum.length);
      for (let i = 0; i < len; i++) {
        mpxSmoothSpectrum[i] =
          (mpxSmoothSpectrum[i] * (MPX_AVG - 1) + arr[i]) / MPX_AVG;
      }
      if (arr.length > len) {
        for (let i = len; i < arr.length; i++) {
          mpxSmoothSpectrum[i] = arr[i];
        }
      }
    }

    mpxSpectrum = mpxSmoothSpectrum.slice();

    updatePilotFromSpectrum();
    updateRdsFromSpectrum();
    updateMpxTotalFromSpectrum();
  }
  
  // ---------------------------------------------------------------
  // RDS — Logic: Gated by WebSocket Status
  // ---------------------------------------------------------------
  function updateRdsFromSpectrum() {
    if (!RDS_ENABLED) {
      updateMeter("rds-meter", 0);
      levels.rds = 0;
      return;
    }

    if (!websocketRdsActive) {
      rdsShortPrev = 0;
      rdsLongPrev = 0;
      levels.rds = 0;
      updateMeter("rds-meter", 0);
      return;
    }

    if (!mpxSpectrum.length) return;

    const F_RDS   = 57000;
    const RDS_BW  = 4500; 
    
    const P_rds   = bandPower(F_RDS, RDS_BW);

    // 1. Lineare Amplitude (wie beim Pilotton)
    let rawAmplitude = Math.sqrt(P_rds);

    // 2. Verstärkungsfaktor
    // Starten Sie hier auch mit 55.0, da Pilot und RDS ähnlich gemessen werden.
    // Wenn die Anzeige nicht stimmt -> diesen Wert ändern.
    const GAIN_FACTOR = 50.0; 

    let devKHz = rawAmplitude * GAIN_FACTOR;

    // Kalibrierung (hier verwenden wir rdsCalibration, falls nötig)
    // Am besten auch oben in der Datei auf 0.0 setzen und alles über GAIN regeln.
    devKHz += rdsCalibration; 

    // Skala geht beim RDS-Meter bis 10.0 kHz
    const RDS_SCALE_MAX_KHZ = 10.0;

    let percent = (devKHz / RDS_SCALE_MAX_KHZ) * 100;

    if (percent > 100) percent = 100;
    if (percent < 0)   percent = 0;

    // 3. Glättung (Dämpfung)
    // Gleiche Einstellung wie beim Pilotton für einheitliche Optik
    const SMOOTHING = 0.90;

    // Wir nutzen rdsLongPrev als Speicher für die Glättung
    rdsLongPrev = (rdsLongPrev * SMOOTHING) + (percent * (1.0 - SMOOTHING));

    updateMeter("rds-meter", rdsLongPrev);
    levels.rds = rdsLongPrev;
  }

  // ---------------------------------------------------------------
  // Pilot — Logic: Gated by WebSocket Status
  // ---------------------------------------------------------------
  function updatePilotFromSpectrum() {
    if (!PILOT_ENABLED) {
      pilotSmooth = 0;
      levels.stereoPilot = 0;
      updateMeter("stereo-pilot-meter", 0);
      return;
    }

    if (!websocketStereoActive && MPXmode === 'off') {
      pilotSmooth = 0;
      levels.stereoPilot = 0;
      updateMeter("stereo-pilot-meter", 0);
      return;
    }

    if (!mpxSpectrum.length) return;

    // Define frequencies
    const F_PILOT    = 19000;
    const F_NOISE_LO = 17000; // Lower noise window
    const F_NOISE_HI = 21000; // Upper noise window
    const BW_SIGNAL  = 800;   // Bandwidth for signal measurement (narrower)
    const BW_NOISE   = 800;   // Bandwidth for noise measurement

    // Measure power
    const P_pilot    = bandPower(F_PILOT, BW_SIGNAL);
    const P_noise_lo = bandPower(F_NOISE_LO, BW_NOISE);
    const P_noise_hi = bandPower(F_NOISE_HI, BW_NOISE);

    // Calculate average noise floor
    const P_noise_avg = (P_noise_lo + P_noise_hi) / 2;

    // Calculate SNR (Signal-to-Noise Ratio)
    // Avoid division by zero if P_noise_avg is extremely small
    const snrRatio = P_pilot / (P_noise_avg + 1e-15);

    // Linear amplitude of the pilot signal
    let rawAmplitude = Math.sqrt(P_pilot);
    const GAIN_FACTOR = 20.0; 
    let devKHz = rawAmplitude * GAIN_FACTOR;
    
    // --- SMART NOISE GATE ---
    // Check two conditions:
    // 1. Is the signal at 19kHz at least 3x stronger than the surrounding noise? (SNR > 3)
    // 2. Is there a minimum level present at all? (> 0.2 kHz)
    
    if (snrRatio > 3.0 && devKHz > 0.2) {
       devKHz += pilotCalibration;
    } else {
       devKHz = 0;
    }

    // HERE: Scale now goes up to 16.0 kHz (linear)
    const PILOT_SCALE_MAX_KHZ = 16.0;
    let percent = (devKHz / PILOT_SCALE_MAX_KHZ) * 100;

    if (percent > 100) percent = 100;
    if (percent < 0)   percent = 0;

    // --- MASSIVE DAMPING (Inertia) ---
    pilotSmooth = pilotSmooth * 0.96 + percent * 0.04;

    levels.stereoPilot = pilotSmooth;
    updateMeter("stereo-pilot-meter", pilotSmooth);
  }
  
  function hideEqHint() {
    const hint = document.getElementById("eqHintText");
    if (!hint) return;
    hint.style.opacity = "0";
    setTimeout(() => {
      if (hint) hint.style.display = "none";
    }, 300);
  }
  
    // ---------------------------------------------------------------
  // MPX Total — Logic
  // ---------------------------------------------------------------
  let mpxPercentPrev = 0;
  let mpxMinHold = 120;
  let mpxMinHoldTimer = 0;
  const MPX_MIN_HOLD_MS = 2000;

  function updateMpxTotalFromSpectrum() {
    if (!MPX_ENABLED) {
      mpxPercentPrev  = 0;
      mpxTotalSmooth  = 0;
      mpxMinHold      = 120;
      levels.mpxTotal = 0;
      updateMeter("mpx-meter", 0);
      return;
    }

    if (!websocketRdsActive) {
      mpxPercentPrev  = 0;
      mpxTotalSmooth  = 0;
      mpxMinHold      = 120;
      levels.mpxTotal = 0;
      updateMeter("mpx-meter", 0);
      return;
    }

    if (!mpxSpectrum.length) return;

    const N       = mpxSpectrum.length;
    const maxFreq = MPX_FMAX;
    const fLimit  = 60000;

    // RMS-Method: Calculate total power of all frequency components
    let sumPower = 0;
    let count = 0;

    for (let i = 0; i < N; i++) {
      const freq = (i / (N - 1)) * maxFreq;
      if (freq > fLimit) break;

      let db = mpxSpectrum[i];
      if (!isFinite(db) || db < -90) continue;

      // dB to linear amplitude
      const amplitude = Math.pow(10, db / 20);
      // Power = Amplitude²
      sumPower += amplitude * amplitude;
      count++;
    }

    if (count === 0 || sumPower === 0) {
      // Don't reset everything immediately to avoid flickering, just decay
      mpxTotalSmooth  = mpxTotalSmooth * 0.9; 
      levels.mpxTotal = mpxTotalSmooth;
      updateMeter("mpx-meter", mpxTotalSmooth);
      return;
    }

    // RMS = Square root of mean power
    const rmsAmplitude = Math.sqrt(sumPower / count);
    
    // RMS-Amplitude to dB
    const rmsDb = 20 * Math.log10(rmsAmplitude + 1e-15);

    // Conversion to kHz deviation
    // Calibrated: -55 dB RMS = approx 15 kHz, -45 dB RMS = approx 35 kHz
    // Formula: devKHz = 75 * 10^((rmsDb + offset) / 20)
    
    const DB_OFFSET = 10.0;  // Adjustment factor
    const SCALE_FACTOR = 1.8;  // Scaling
    
    let devKHz = 75.0 * Math.pow(10, (rmsDb + DB_OFFSET) / 20) * SCALE_FACTOR;

    // Apply calibration
    devKHz += mpxCalibration;

    if (devKHz < 0)   devKHz = 0;
    if (devKHz > 120) devKHz = 120;

    // --- MINIMUM-HOLD LOGIC ---
    const now = Date.now();
    
    if (devKHz < mpxMinHold) {
      mpxMinHold = devKHz;
      mpxMinHoldTimer = now;
    }
    
    if (now - mpxMinHoldTimer > MPX_MIN_HOLD_MS) {
      const riseSpeed = 0.02;
      if (devKHz > mpxMinHold) {
        mpxMinHold = mpxMinHold + (devKHz - mpxMinHold) * riseSpeed;
      }
    }

    // Using mpxMinHold creates a "floor" that rises slowly, 
    // ensuring readability of fluctuating values
    let displayKHz = mpxMinHold;

    // Use actual current value if it's higher than the hold floor
    if (devKHz > displayKHz) {
        displayKHz = devKHz;
    }

    let percent = (displayKHz / 120) * 100;

    if (percent < 0)   percent = 0;
    if (percent > 100) percent = 100;

    // Smoothing
    const shortSmoothFactor = 0.85;
    percent = percent * (1 - shortSmoothFactor) +
              mpxPercentPrev * shortSmoothFactor;
    mpxPercentPrev = percent;

    const longSmoothFactor = 0.95;
    mpxTotalSmooth = mpxTotalSmooth * longSmoothFactor +
                     percent * (1 - longSmoothFactor);

    levels.mpxTotal = mpxTotalSmooth;
    updateMeter("mpx-meter", mpxTotalSmooth);
  }
  
  // ---------------------------------------------------------------
  // Stereo audio meters
  // ---------------------------------------------------------------
  function hideEqHint() {
    const hint = document.getElementById("eqHintText");
    if (!hint) return;
    hint.style.opacity = "0";
    setTimeout(() => {
      if (hint) hint.style.display = "none";
    }, 300);
  }

    function setupAudioMeters() {
    if (
      typeof Stream === "undefined" ||
      !Stream ||
      !Stream.Fallback ||
      !Stream.Fallback.Player ||
      !Stream.Fallback.Player.Amplification
    ) {
      setTimeout(setupAudioMeters, 2000);
      return;
    }

    const player     = Stream.Fallback.Player;
    const sourceNode = player.Amplification;

    if (!sourceNode || !sourceNode.context) {
      console.warn("[MetricsMeters] No valid AudioNode for Amplification found – retrying…");
      setTimeout(setupAudioMeters, 2000);
      return;
    }

    try {
      const ctx = sourceNode.context;

      if (stereoAudioContext !== ctx) {
        stereoAudioContext = ctx;
        stereoSourceNode   = null;
        stereoSplitter     = null;
        stereoAnalyserL    = null;
        stereoAnalyserR    = null;
        stereoDataL        = null;
        stereoDataR        = null;
      }

      if (stereoSplitter && stereoAnalyserL && stereoAnalyserR) {
        if (!stereoAnimationId) {
          startStereoAnimation();
        }
        hideEqHint(); // <--- ADDED HERE
        return;
      }

      stereoSourceNode = sourceNode;
      stereoSplitter   = stereoAudioContext.createChannelSplitter(2);
      stereoAnalyserL  = stereoAudioContext.createAnalyser();
      stereoAnalyserR  = stereoAudioContext.createAnalyser();

      stereoAnalyserL.fftSize = 2048;
      stereoAnalyserR.fftSize = 2048;

      stereoDataL = new Uint8Array(stereoAnalyserL.frequencyBinCount);
      stereoDataR = new Uint8Array(stereoAnalyserR.frequencyBinCount);

      stereoSourceNode.connect(stereoSplitter);
      stereoSplitter.connect(stereoAnalyserL, 0);
      stereoSplitter.connect(stereoAnalyserR, 1);

      if (!stereoAnimationId) {
        startStereoAnimation();
      }
      hideEqHint();
    } catch (e) {
      console.error("[MetricsMeters] Error while setting up stereo audio analysers", e);
    }
  }

  function startStereoAnimation() {
    if (stereoAnimationId) cancelAnimationFrame(stereoAnimationId);

    const loop = () => {
      if (!stereoAnalyserL || !stereoAnalyserR || !stereoDataL || !stereoDataR) {
        stereoAnimationId = requestAnimationFrame(loop);
        return;
      }

      stereoAnalyserL.getByteTimeDomainData(stereoDataL);
      stereoAnalyserR.getByteTimeDomainData(stereoDataR);

      let maxL = 0;
      let maxR = 0;

      for (let i = 0; i < stereoDataL.length; i++) {
        const d = Math.abs(stereoDataL[i] - 128);
        if (d > maxL) maxL = d;
      }
      for (let i = 0; i < stereoDataR.length; i++) {
        const d = Math.abs(stereoDataR[i] - 128);
        if (d > maxR) maxR = d;
      }

      let levelL = ((maxL / 128) * 100) * stereoBoost;
      let levelR = ((maxR / 128) * 100) * stereoBoost;

      levelL = Math.min(100, Math.max(0, levelL));
      levelR = Math.min(100, Math.max(0, levelR));

      levels.left  = levelL;
      levels.right = levelR;

      updateMeter("left-meter",  levelL);
      updateMeter("right-meter", levelR);

      stereoAnimationId = requestAnimationFrame(loop);
    };

    stereoAnimationId = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------
  function setupMetricsWebSocket() {
    const currentURL    = window.location;
    const webserverPort = currentURL.port || (currentURL.protocol === "https:" ? "443" : "80");
    const protocol      = currentURL.protocol === "https:" ? "wss:" : "ws:";
    const webserverURL  = currentURL.hostname;
    const websocketURL  = `${protocol}//${webserverURL}:${webserverPort}/data_plugins`;

    const socket = new WebSocket(websocketURL);

    socket.onopen = () => {
      console.log("[MetricsMeters] WebSocket connection opened");
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (Array.isArray(message)) {
        handleMpxArray(message);
        return;
      }

      if (!message || typeof message !== "object") return;
      const type = message.type ? String(message.type).toLowerCase() : "";

      if (type === "mpx") {
        handleMpxArray(message.value);
        return;
      }
    };

    socket.onerror = (error) => {
      console.error("[MetricsMeters] WebSocket error:", error);
    };

    socket.onclose = () => {
      console.log("[MetricsMeters] WebSocket connection closed");
    };
  }

  // ---------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------
  function initMeters(levelMeterContainer) {
    const container = levelMeterContainer;
    if (!container) return;

    container.innerHTML = "";

    const stereoGroup = document.createElement("div");
    stereoGroup.classList.add("stereo-group");
	
	createLevelMeter("left-meter",  "LEFT",  stereoGroup, scales.left);
    createLevelMeter("right-meter", "RIGHT", stereoGroup, scales.right);

    container.appendChild(stereoGroup);

    // --- HINT OVERLAY ---
    const eqHintWrapper = document.createElement("div");
    eqHintWrapper.id = "eqHintWrapper";
    const eqHintText = document.createElement("div");
    eqHintText.id = "eqHintText";
    eqHintText.innerText = "Click play to show";
    eqHintWrapper.style.left = "-50%";
    eqHintWrapper.appendChild(eqHintText);
    stereoGroup.appendChild(eqHintWrapper);

    const hfScale = buildHFScale(hfUnit);
    createLevelMeter("hf-meter", "RF", container, hfScale);

    const hfLevelMeter = container.querySelector("#hf-meter")?.closest(".level-meter");
    if (hfLevelMeter) {
      hfLevelMeter.style.transform = "translateX(0px)";
    }

    createLevelMeter("stereo-pilot-meter", "PILOT", container, scales.stereoPilot);
    createLevelMeter("mpx-meter",          "MPX",   container, scales.mpx);
    createLevelMeter("rds-meter",          "RDS",   container, scales.rds);

    const pilotMeterEl = container.querySelector("#stereo-pilot-meter")?.closest(".level-meter");
    if (pilotMeterEl && !PILOT_ENABLED) {
      pilotMeterEl.style.opacity = "0.4";
    }

    const rdsMeterEl = container.querySelector("#rds-meter")?.closest(".level-meter");
    if (rdsMeterEl && !RDS_ENABLED) {
      rdsMeterEl.style.opacity = "0.4";
    }

    const mpxMeterEl = container.querySelector("#mpx-meter")?.closest(".level-meter");
    if (mpxMeterEl && !MPX_ENABLED) {
      mpxMeterEl.style.opacity = "0.4";
    }

    updateMeter("left-meter",  levels.left       || 0);
    updateMeter("right-meter", levels.right      || 0);
    updateMeter("hf-meter",    levels.hf         || 0);
    updateMeter("stereo-pilot-meter", levels.stereoPilot || 0);
    updateMeter("mpx-meter",   levels.mpxTotal   || 0);
    updateMeter("rds-meter",   levels.rds        || 0);

    setupMetricsWebSocket();
    setupAudioMeters();
    if (!stereoSetupIntervalId) {
      stereoSetupIntervalId = setInterval(setupAudioMeters, 3000);
    }

    if (!hfUnitListenerAttached &&
        window.MetricsMonitor &&
        typeof window.MetricsMonitor.onSignalUnitChange === "function") {

      hfUnitListenerAttached = true;

      window.MetricsMonitor.onSignalUnitChange((unit) => {
        if (window.MetricsMeters && typeof window.MetricsMeters.setHFUnit === "function") {
          window.MetricsMeters.setHFUnit(unit);
        }
      });
    }
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  window.MetricsMeters = {
    levels,
    updateMeter,
    initMeters,

    // Setters called by metricsmonitor-header.js
    setStereoStatus(isActive) {
      websocketStereoActive = !!isActive;
    },
    setRdsStatus(isActive) {
      websocketRdsActive = !!isActive;
    },

    getStereoBoost() {
      return stereoBoost;
    },

    setStereoBoost(value) {
      const v = Number(value);
      if (!isNaN(v) && v > 0) {
        // stereoBoost = v;
      }
    },

setHF(baseValue) {
  const v = Number(baseValue);
  if (!isFinite(v)) return;

  levels.hfBase = v;
  const displayHF = hfBaseToDisplay(v);
  levels.hfValue = displayHF;

  const percent = hfPercentFromBase(v);
  levels.hf = percent;
  updateMeter("hf-meter", percent);
},

    setHFUnit(unit) {
      console.log("[MetricsMeters] setHFUnit() :: new unit =", unit);

      if (!unit) {
        console.warn("[MetricsMeters] setHFUnit(): unit is empty");
        return;
      }

      hfUnit = unit.toLowerCase();

      const meterEl = document.getElementById("hf-meter");
      if (!meterEl) {
        console.warn("[MetricsMeters] setHFUnit(): RF meter not found in DOM!");
        return;
      }

      const levelMeter = meterEl.closest(".level-meter");
      if (!levelMeter) {
        console.warn("[MetricsMeters] setHFUnit(): level-meter wrapper missing!");
        return;
      }

      const scaleEl = levelMeter.querySelector(".meter-scale");
      if (!scaleEl) {
        console.warn("[MetricsMeters] setHFUnit(): scale element not found!");
        return;
      }

      const newScale = buildHFScale(hfUnit);
      console.log("[MetricsMeters] New RF scale =", newScale);

      const ticks = scaleEl.querySelectorAll("div");
      newScale.forEach((txt, idx) => {
        if (ticks[idx]) {
          ticks[idx].innerText = txt;
        }
      });

      if (typeof levels.hfBase === "number") {
        const displayHF = hfBaseToDisplay(levels.hfBase);
        levels.hfValue = displayHF;
        console.log("[MetricsMeters] Recalculated RF value =", displayHF);
      }
    }
  };
})();