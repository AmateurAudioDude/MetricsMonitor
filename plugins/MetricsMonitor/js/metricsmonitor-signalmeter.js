///////////////////////////////////////////////////////////////
///  METRICS MONITOR – SignalMeter + Signal-Meter Module      ///
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

let hfUnit = "dbf";
let hfUnitListenerAttached = false;

const levels = {
  hf: 0,
  hfValue: 0,
  hfBase: 0,
  left: 0,
  right: 0
};

let highestSignal = -Infinity;

const PEAK_CONFIG = {
  smoothing: 0.85,
  holdMs: 5000
};

const peaks = {
  left:  { value: 0, lastUpdate: Date.now() },
  right: { value: 0, lastUpdate: Date.now() }
};

let eqAudioContext = null;
let eqAnimationId = null;
let eqSourceNode = null;

let stereoSplitter = null;
let stereoAnalyserL = null;
let stereoAnalyserR = null;
let stereoDataL = null;
let stereoDataR = null;

let eqSetupIntervalId = null;

// -------------------------------------------------------
// HF unit conversion
// -------------------------------------------------------
function hfBaseToDisplay(baseHF) {
  const ssu = (hfUnit || "").toLowerCase();
  const v = Number(baseHF);
  if (!isFinite(v)) return 0;
  if (ssu === "dbuv" || ssu === "dbµv" || ssu === "dbμv") return v - 10.875;
  if (ssu === "dbm") return v - 119.75;
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
        // NEU: Einheit nur beim letzten Element (0) hinzufügen
        return idx === lastIndex ? `${rounded} dBm` : `${rounded}`;
      });
    }

    if (ssu === "dbf") {
      return baseScale_dBuV.map((v, idx) => {
        const dBf = v + 10.875
        const rounded = round10(dBf);
        // NEU: Einheit nur beim letzten Element (0) hinzufügen
        return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
      });
    }

    // Default: dBµV
    return baseScale_dBuV.map((v, idx) => {
      const rounded = round10(v);
      // NEU: Einheit nur beim letzten Element (0) hinzufügen
      return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
    });
  }

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
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

function stereoColorForPercent(p, totalSegments = 30) {
  const i = Math.max(0, Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1));
  const topBandStart = totalSegments - 5;
  if (i >= topBandStart) {
    const red = Math.round((i / 10) * 125);
    return `rgb(${red},0,0)`;
  } else {
    const green = 100 + Math.round((i / totalSegments) * 155);
    return `rgb(0,${green},0)`;
  }
}

function setPeakSegment(meterEl, peak, meterId) {
  const segments = meterEl.querySelectorAll(".segment");
  if (!segments.length) return;
  const prev = meterEl.querySelector(".segment.peak-flag");
  if (prev) prev.classList.remove("peak-flag");

  const idx = Math.max(0, Math.min(segments.length - 1, Math.round((peak / 100) * segments.length) - 1));
  const seg = segments[idx];
  if (!seg) return;
  
  seg.classList.add("peak-flag");
  if (meterId && (meterId.includes("left") || meterId.includes("right"))) {
    seg.style.backgroundColor = stereoColorForPercent(peak, segments.length);
  }
}

// -------------------------------------------------------
// Audio Logic (hinzugefügt, damit Pegel funktionieren)
// -------------------------------------------------------

function hideEqHint() {
  const hint = document.getElementById("eqHintText");
  if (!hint) return;
  hint.style.opacity = "0";
  setTimeout(() => {
    if (hint) hint.style.display = "none";
  }, 300);
}

function setupAudioEQ() {
  // Warten bis das Stream-Objekt verfügbar ist
  if (
    typeof Stream === "undefined" ||
    !Stream ||
    !Stream.Fallback ||
    !Stream.Fallback.Player ||
    !Stream.Fallback.Player.Amplification
  ) {
    // Später erneut versuchen
    // setTimeout(setupAudioEQ, 2000); // wird durch Intervall abgedeckt
    return;
  }

  const player = Stream.Fallback.Player;
  const sourceNode = player.Amplification;

  if (!sourceNode || !sourceNode.context) {
    return;
  }

  try {
    const ctx = sourceNode.context;

    // Falls sich der AudioContext geändert hat
    if (eqAudioContext !== ctx) {
      eqAudioContext   = ctx;
      stereoSplitter   = null;
      stereoAnalyserL  = null;
      stereoAnalyserR  = null;
      stereoDataL      = null;
      stereoDataR      = null;
      eqSourceNode     = null;
    }

    eqSourceNode = sourceNode;

    // Stereo Splitter erstellen
    if (!stereoSplitter) {
      stereoSplitter  = eqAudioContext.createChannelSplitter(2);
      stereoAnalyserL = eqAudioContext.createAnalyser();
      stereoAnalyserR = eqAudioContext.createAnalyser();

      stereoAnalyserL.fftSize = 2048;
      stereoAnalyserR.fftSize = 2048;

      stereoDataL = new Uint8Array(stereoAnalyserL.frequencyBinCount);
      stereoDataR = new Uint8Array(stereoAnalyserR.frequencyBinCount);

      eqSourceNode.connect(stereoSplitter);
      stereoSplitter.connect(stereoAnalyserL, 0);
      stereoSplitter.connect(stereoAnalyserR, 1);
    }

    // Animation starten
    if (!eqAnimationId) {
      startEqAnimation();
    }

    // Hinweis ausblenden
    hideEqHint();
  } catch (e) {
    console.error("MetricsSignalMeter: Error while setting up audio analyser", e);
  }
}

function startEqAnimation() {
  if (eqAnimationId) cancelAnimationFrame(eqAnimationId);

  const loop = () => {
    // ---- Stereo LEFT / RIGHT (time domain) ----
    if (stereoAnalyserL && stereoAnalyserR && stereoDataL && stereoDataR) {
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

      levels.left = levelL;
      levels.right = levelR;

      updateMeter("left-meter", levelL);
      updateMeter("right-meter", levelR);
    }

    eqAnimationId = requestAnimationFrame(loop);
  };

  eqAnimationId = requestAnimationFrame(loop);
}

// -------------------------------------------------------
// Meter creation
// -------------------------------------------------------
function createLevelMeter(id, label, container, scaleValues) {
  const levelMeter = document.createElement("div");
  levelMeter.classList.add("signal-level-meter");
  const top = document.createElement("div");
  top.classList.add("meter-top");
  const meterBar = document.createElement("div");
  meterBar.classList.add("signal-meter-bar");
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
  if (id.includes("left")) labelElement.classList.add("label-left");
  if (id.includes("right")) labelElement.classList.add("label-right");
  meterWrapper.appendChild(meterBar);
  meterWrapper.appendChild(labelElement);
  if (scaleValues && scaleValues.length > 0) {
    const scale = document.createElement("div");
    scale.classList.add("signal-meter-scale");
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
  const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
  const segments = meter.querySelectorAll(".segment");
  const activeCount = Math.round((safeLevel / 100) * segments.length);
  segments.forEach((seg, i) => {
    if (i < activeCount) {
      if (meterId.includes("left") || meterId.includes("right")) {
        if (i >= segments.length - 5) {
          const red = Math.round((i / 10) * 125);
          seg.style.backgroundColor = `rgb(${red},0,0)`;
        } else {
          const green = 100 + Math.round((i / segments.length) * 155);
          seg.style.backgroundColor = `rgb(0,${green},0)`;
        }
      } else if (meterId.includes("hf")) {
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
        seg.style.backgroundColor = "#333";
      }
    } else {
      seg.style.backgroundColor = "#333";
    }
  });
  if (meterId.includes("left") || meterId.includes("right")) {
    let key = meterId.includes("left") ? "left" : "right";
    updatePeakValue(key, safeLevel);
    setPeakSegment(meter, peaks[key].value, meterId);
  }
}

// -------------------------------------------------------
// Public init
// -------------------------------------------------------
function initSignalMeter(containerOrId = "level-meter-container") {
  const container = typeof containerOrId === "string" ? document.getElementById(containerOrId) : containerOrId;
  if (!container) return;

  if (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === "function") {
    const u = window.MetricsMonitor.getSignalUnit();
    if (u) hfUnit = u.toLowerCase();
  }

  container.innerHTML = "";

  // Stereo group
  const stereoGroup = document.createElement("div");
  stereoGroup.classList.add("stereo-group");
  
  // --- HINT OVERLAY ---
  const eqHintWrapper = document.createElement("div");
  eqHintWrapper.id = "eqHintWrapper";
  const eqHintText = document.createElement("div");
  eqHintText.id = "eqHintText";
  eqHintText.innerText = "Click play to show";

  if (
    typeof Stream !== "undefined" &&
    Stream &&
    Stream.Fallback &&
    Stream.Fallback.Player &&
    Stream.Fallback.Player.Amplification
  ) {
    // Wenn Audio da ist, sofort unsichtbar machen
    eqHintText.style.opacity = "0";
    eqHintText.style.display = "none";
  }
  // ---------------------------------------------------------

  eqHintWrapper.style.left = "-50%";
  eqHintWrapper.appendChild(eqHintText);
  stereoGroup.appendChild(eqHintWrapper);

  const stereoScale = ["+5,0 dB", "0,0", "-5,0", "-10,0", "-15,0", "-20,0", "-25,0", "-30,0", "-35,0 dB"];
  createLevelMeter("left-meter", "LEFT", stereoGroup, stereoScale);
  createLevelMeter("right-meter", "RIGHT", stereoGroup, []);
  container.appendChild(stereoGroup);

  // HF meter
  const hfScale = buildHFScale(hfUnit);
  createLevelMeter("hf-meter", "RF", container, hfScale);
  const hfLevelMeter = container.querySelector("#hf-meter")?.closest(".signal-level-meter");
  if (hfLevelMeter) {
    hfLevelMeter.style.transform = "translateX(-5px)";
  }

  // --- SIGNAL PANEL ---
  const signalPanel = document.createElement("div");
  signalPanel.className = "panel-33 no-bg-phone signal-panel-layout";
  
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
  container.appendChild(signalPanel);

  updateMeter("left-meter", levels.left);
  updateMeter("right-meter", levels.right);
  updateMeter("hf-meter", levels.hf || 0);

  if (typeof levels.hfBase === "number") {
     window.MetricsSignalMeter.setHF(levels.hfBase);
  }

  // Unit Listener
  if (!hfUnitListenerAttached && window.MetricsMonitor && window.MetricsMonitor.onSignalUnitChange) {
    hfUnitListenerAttached = true;
    window.MetricsMonitor.onSignalUnitChange((unit) => {
      if (window.MetricsSignalMeter && window.MetricsSignalMeter.setHFUnit) {
        window.MetricsSignalMeter.setHFUnit(unit);
      }
    });
  }

  // Start Audio Logic
  setupAudioEQ();
  if (!eqSetupIntervalId) {
    eqSetupIntervalId = setInterval(setupAudioEQ, 3000);
  }
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------
window.MetricsSignalMeter = {
  init: initSignalMeter,

setHF(baseValue) {
  // NEU: Korrekturwert, um die Anzeige anzupassen
  const correction = 2.4;
  const v = Number(baseValue) + correction;

  if (!isFinite(v)) return;

  levels.hfBase = v;
  const displayHF = hfBaseToDisplay(v);
  levels.hfValue = displayHF;

  const percent = hfPercentFromBase(v);
  levels.hf = percent;
  updateMeter("hf-meter", percent);
},

  setHFUnit(unit) {
    if (!unit) return;
    hfUnit = unit.toLowerCase();
    highestSignal = -Infinity;
    const elHighest = document.getElementById("data-signal-highest");
    if(elHighest) elHighest.innerText = "---";

    const meterEl = document.getElementById("hf-meter");
    if (meterEl) {
      const levelMeter = meterEl.closest(".signal-level-meter");
      if (levelMeter) {
        const scaleEl = levelMeter.querySelector(".signal-meter-scale");
        if (scaleEl) {
          const newScale = buildHFScale(hfUnit);
          const ticks = scaleEl.querySelectorAll("div");
          newScale.forEach((txt, idx) => { if (ticks[idx]) ticks[idx].innerText = txt; });
        }
      }
    }

    const unitSpans = document.querySelectorAll(".signal-units");
    unitSpans.forEach(span => {
      span.innerText = hfUnit;
    });

    if (typeof levels.hfBase === "number") {
      window.MetricsSignalMeter.setHF(levels.hfBase);
    }
  },

  levels,
  updateMeter
};

})();