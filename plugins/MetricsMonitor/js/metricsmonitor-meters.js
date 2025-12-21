///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-meters.js (V1.4)                          //
//                                                           //
//  by Highpoint               last update: 19.12.2025       //
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

    // ==========================================================
    // DEBUG CONFIGURATION
    // ==========================================================
    const ENABLE_DEBUG = false;
    const DEBUG_INTERVAL_MS = 2000;   
    let lastDebugTime = 0;

    // Custom CSS for value displays
    const style = document.createElement('style');
    style.innerHTML = `
      /* Value display above the bar */
      .value-display {
        text-align: center;
        font-size: 10px !important;
        line-height: 12px;
        height: 12px;
        color: #ddd;
        font-family: inherit;
        margin-bottom: 2px;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  
    // Sample rate dependent flags
    const RDS_ENABLED   = (sampleRate === 192000);
    const PILOT_ENABLED = (sampleRate !== 48000);
    const MPX_ENABLED   = (sampleRate === 192000);
  
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
  
    let websocketStereoActive = false;
    let websocketRdsActive = false;
    
    let isRdsGateOpen = false;
  
    const PEAK_CONFIG = {
      smoothing: 0.85,
      holdMs: 5000
    };
  
    const peaks = {
      left:  { value: 0, lastUpdate: Date.now() },
      right: { value: 0, lastUpdate: Date.now() }
    };
  
    // MPX Spectrum data
    let mpxSpectrum = [];
    let mpxSmoothSpectrum = [];
    
    let mpxPeakVal   = 0; 
    let pilotPeakVal = 0;
    let rdsPeakVal   = 0;
    let noiseFloorVal = 0.000001; 
    let hasTimeDomainData = false;
    
    const MPX_DB_MIN   = -90;
    const MPX_DB_MAX   = 0;
    const MPX_FMAX     = 96000;
    const MPX_AVG      = 6;
  
    let pilotSmooth    = 0;
    let rdsShortPrev   = 0;
    let rdsLongPrev    = 0;
  
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
  
    // RF Unit handling
    let hfUnit = "dbf";
    let hfUnitListenerAttached = false;
  
    if (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === "function") {
      const u = window.MetricsMonitor.getSignalUnit();
      if (u) {
        hfUnit = u.toLowerCase();
      }
    }
  
    // Convert Base dBf to Display Unit
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
  
    // Convert Base dBf to Percentage (0-100)
    function hfPercentFromBase(baseHF) {
      const v = Number(baseHF);
      if (!isFinite(v)) return 0;
  
      let dBuV = v - 10.875;
      if (isNaN(dBuV)) dBuV = 0;
  
      const clamped = Math.max(0, Math.min(90, dBuV));
      return (clamped / 90) * 100;
    }
  
    // Build RF Scale labels
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
          return idx === lastIndex ? `${rounded} dBm` : `${rounded}`;
        });
      }
  
      if (ssu === "dbf") {
        return baseScale_dBuV.map((v, idx) => {
          const dBf = v + 10.875
          const rounded = round10(dBf);
          return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
        });
      }
  
      return baseScale_dBuV.map((v, idx) => {
        const rounded = round10(v);
        return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
      });
    }
  
    // Stereo audio context
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
      left: ["+5 dB","0","-5","-10","-15","-20","-25","-30","-35 dB"],
      right: [],
      stereoPilot: ["16","14","12","10","8","6","4","2","0 kHz"],
      hf: [],
      rds: ["10","9","8","7","6","5","4","3","2","1","0 kHz"],
      mpx: ["120","105","90","75","60","45","30","15","0 kHz"]
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
      const baseId = meterId;
      const targets = [];
      const el1 = document.getElementById(baseId);
      if (el1) targets.push(el1);
      const el2 = document.getElementById(`mm-combo-${baseId}`);
      if (el2 && el2 !== el1) targets.push(el2);
      if (!targets.length) return;

      targets.forEach((meter) => {
        const meterId = baseId;
  
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
               const dBuV_from_percent = (safeLevel / 100) * 90;             
               let baseHF = dBuV_from_percent + 10.875;
               let displayValue = hfBaseToDisplay(baseHF);
               const u = (hfUnit || "").toLowerCase();
               text = displayValue.toFixed(1);
			   
            } else if (isPilot) {
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
    
            // Throttle text updates
            const now = Date.now();
            let updateInterval = 50; 
            
            // Slower updates for RDS/MPX to prevent jitter
            if (isRds || isMpx) {
                updateInterval = 150; 
            }

            const lastUpdate = parseInt(valDisp.getAttribute("data-last-update") || "0");
            
            if (now - lastUpdate > updateInterval) {
                 valDisp.innerText = text;
                 valDisp.setAttribute("data-last-update", now);
            }
          }
        }
        });
      }
    
      function handleMpxArray(data) {
        if (!data || (!Array.isArray(data) && !(data instanceof Float32Array) && !(data instanceof Uint8Array))) {
          return;
        }
    
        const mags = [];
        const dataLen = data.length;
        
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
    // RDS Logic - Additive calibration & Ballistics
    // ---------------------------------------------------------------
    let rdsSigSmooth   = 0;
    let rdsNoiseSmooth = 0;
    let rdsDisplay     = 0;
    let rdsInitialized = false;
    const rdsMedianBuf = [];
    const MEDIAN_LEN   = 25;

    function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
    }

    function updateRdsFromSpectrum() {
    if (!websocketRdsActive || !RDS_ENABLED) {
        updateMeter("rds-meter", 0);
        levels.rds = 0;
        rdsMedianBuf.length = 0;
        isRdsGateOpen = false;
        rdsInitialized = false;
        return;
    }

    let devKHz = 0;
    let gateOpen = false;

    // Time-Domain-only logic
    if (rdsPeakVal === 0 || pilotPeakVal === 0) {
        devKHz = 0;
        gateOpen = false;
    } else {
        const rawDevKHz = rdsPeakVal
        
        const isStrongSignal = rawDevKHz > 0.8;
        
        if (isStrongSignal) {
        devKHz = rawDevKHz;
        if (devKHz > 0.25) gateOpen = true; 
        }
    }

    isRdsGateOpen = gateOpen;
    if (!gateOpen) devKHz = 0;

    if (devKHz === 0) {
        rdsMedianBuf.length = 0;
        rdsDisplay = 0;
        updateMeter("rds-meter", 0);
        levels.rds = 0;
        return;
    }

    const RDS_SCALE_MAX_KHZ = 10.0;
    let percent = Math.max(0, Math.min(100, (devKHz / RDS_SCALE_MAX_KHZ) * 100));

    // Median filtering
    rdsMedianBuf.push(percent);
    if (rdsMedianBuf.length > MEDIAN_LEN) rdsMedianBuf.shift();

    let targetPercent =
        rdsMedianBuf.length < MEDIAN_LEN ? Math.min(...rdsMedianBuf) : median(rdsMedianBuf);

    // Jump-start
    if (!rdsInitialized && targetPercent > 0) {
        rdsDisplay = targetPercent;
        rdsInitialized = true;
    }

    // Very slow ballistics
    const ATTACK = 0.02;  
    const RELEASE = 0.02; 
    const DEADBAND_PCT = 0.4;

    if (Math.abs(targetPercent - rdsDisplay) < DEADBAND_PCT) {
        targetPercent = rdsDisplay;
    }

    if (targetPercent > rdsDisplay) {
        rdsDisplay = rdsDisplay * (1 - ATTACK) + targetPercent * ATTACK;
    } else {
        rdsDisplay = rdsDisplay * (1 - RELEASE) + targetPercent * RELEASE;
    }

    updateMeter("rds-meter", rdsDisplay);
    levels.rds = rdsDisplay;
    }
    
      // ---------------------------------------------------------------
      // Pilot Logic - Additive calibration
      // ---------------------------------------------------------------
      function updatePilotFromSpectrum() {
        if (!PILOT_ENABLED) {
          pilotSmooth = 0;
          levels.stereoPilot = 0;
          updateMeter("stereo-pilot-meter", 0);
          return;
        }
        
        let devKHz = 0;
        let gateOpen = false;

        if (pilotPeakVal === 0) {
            devKHz = 0;
            gateOpen = false;
            pilotSmooth = 0; 
        } else {
            devKHz = pilotPeakVal
            if (devKHz > 0.5) gateOpen = true;
        }
        
        if (!gateOpen) devKHz = 0;
        
        // Squelch
        if (devKHz === 0) {
            updateMeter("stereo-pilot-meter", 0);
            levels.stereoPilot = 0;
            pilotSmooth = 0;
            
            levels.rds = 0;
            levels.mpxTotal = 0;
            updateMeter("rds-meter", 0);
            updateMeter("mpx-meter", 0);
            
            rdsDisplay = 0; rdsLongPrev = 0; rdsMedianBuf.length = 0;
            mpxDisplayValue = 0; mpxPeakHold = 0; mpxInputSmooth = 0;
            
            return; 
        }
    
        const PILOT_SCALE_MAX_KHZ = 16.0;
        let percent = (devKHz / PILOT_SCALE_MAX_KHZ) * 100;
    
        if (percent > 100) percent = 100;
        if (percent < 0)   percent = 0;
    
        if (percent > pilotSmooth) {
            pilotSmooth = pilotSmooth * 0.80 + percent * 0.20;
        } else {
            pilotSmooth = pilotSmooth * 0.95 + percent * 0.05;
        }
    
        levels.stereoPilot = pilotSmooth;
        updateMeter("stereo-pilot-meter", pilotSmooth);
    
        if (ENABLE_DEBUG && Date.now() - lastDebugTime > DEBUG_INTERVAL_MS) {
          console.log(`%c[PILOT]`, 'color: cyan; font-weight: bold;');
          console.table({
              "Mode": "TimeDomain (Exclusive)",
              "Raw": pilotPeakVal.toFixed(6),
              "Result Dev (kHz)": devKHz.toFixed(3)
          });
        }
      }

    // ---------------------------------------------------------------
    // MPX Total Logic - Additive calibration & Ballistics
    // ---------------------------------------------------------------
    let mpxPeakHold      = 0;
    let mpxPeakHoldTimer = 0;
    let mpxDisplayValue  = 0;
    const MPX_PEAK_HOLD_MS   = 80;
    const MPX_OVERSHOOT_KHZ  = 4;

    let mpxInputSmooth = 0;

    function updateMpxTotalFromSpectrum() {
    if (!MPX_ENABLED || !websocketRdsActive) {
        mpxPeakHold = 0;
        mpxDisplayValue = 0;
        levels.mpxTotal = 0;
        mpxInputSmooth = 0;
        updateMeter("mpx-meter", 0);
        return;
    }

    if (mpxPeakVal === 0 || pilotPeakVal === 0) {
        mpxInputSmooth = 0;
        mpxDisplayValue = 0;
        mpxPeakHold = 0;
        updateMeter("mpx-meter", 0);
        levels.mpxTotal = 0;
        return;
    }

    let devKHz = mpxPeakVal

    devKHz = Math.max(0, Math.min(120, devKHz));

    // Input smoothing
    if (mpxInputSmooth < 1.0 && devKHz > 8.0) {
        mpxInputSmooth = devKHz;
    } else if (devKHz > mpxInputSmooth) {
        mpxInputSmooth = mpxInputSmooth * 0.88 + devKHz * 0.12;
    } else {
        mpxInputSmooth = mpxInputSmooth * 0.90 + devKHz * 0.10;
    }

    const targetVal = mpxInputSmooth;
    const now = Date.now();

    // Display Ballistics
    if (targetVal > mpxDisplayValue) {
        mpxDisplayValue += (targetVal - mpxDisplayValue) * 0.18;
        mpxPeakHold = mpxDisplayValue;
        mpxPeakHoldTimer = now;
    } else if (targetVal < mpxDisplayValue) {
        const bigDrop = targetVal < mpxDisplayValue * 0.7;
        if (bigDrop) {
        mpxDisplayValue = targetVal;
        } else if (now - mpxPeakHoldTimer < MPX_PEAK_HOLD_MS) {
        mpxDisplayValue = mpxPeakHold;
        } else {
        mpxDisplayValue = mpxDisplayValue * 0.85;
        if (mpxDisplayValue < targetVal) mpxDisplayValue = targetVal;
        }
    }

    // Overshoot Limit
    const maxOvershoot = Math.max(MPX_OVERSHOOT_KHZ, targetVal * 0.10);
    if (mpxDisplayValue > targetVal + maxOvershoot) {
        mpxDisplayValue = targetVal + maxOvershoot;
    }

    const percent = Math.min(100, Math.max(0, (mpxDisplayValue / 120) * 100));
    levels.mpxTotal = percent;
    updateMeter("mpx-meter", percent);
    }
      
        // ---------------------------------------------------------------
        // Audio Setup & Init
        // ---------------------------------------------------------------
        function setupAudioMeters() {
          if (
            typeof Stream === "undefined" ||
            !Stream ||
            !Stream.Fallback ||
            !Stream.Fallback.Player ||
            !Stream.Fallback.Player.Amplification
          ) {
            return;
          }

          const player     = Stream.Fallback.Player;
          const sourceNode = player.Amplification;
      
          if (!sourceNode || !sourceNode.context) {
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
              return;
            }
      
            stereoSourceNode = sourceNode;
            
            // Re-create nodes if missing
            stereoSplitter   = stereoAudioContext.createChannelSplitter(2);
            stereoAnalyserL  = stereoAudioContext.createAnalyser();
            stereoAnalyserR  = stereoAudioContext.createAnalyser();
      
            stereoAnalyserL.fftSize = 2048;
            stereoAnalyserR.fftSize = 2048;
      
            stereoDataL = new Uint8Array(stereoAnalyserL.frequencyBinCount);
            stereoDataR = new Uint8Array(stereoAnalyserR.frequencyBinCount);
      
            try {
                stereoSourceNode.connect(stereoSplitter);
                stereoSplitter.connect(stereoAnalyserL, 0);
                stereoSplitter.connect(stereoAnalyserR, 1);
            } catch(e) {}
      
            if (!stereoAnimationId) {
              startStereoAnimation();
            }
          } catch (e) {
            console.error("[MetricsMeters] Error", e);
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
      
        // Global socket variable to handle disconnects
        let mpxSocket = null;
      
        function setupMetricsWebSocket() {
          const currentURL    = window.location;
          const webserverPort = currentURL.port || (currentURL.protocol === "https:" ? "443" : "80");
          const protocol      = currentURL.protocol === "https:" ? "wss:" : "ws:";
          const webserverURL  = currentURL.hostname;
          const websocketURL  = `${protocol}//${webserverURL}:${webserverPort}/data_plugins`;
      
          if (mpxSocket) {
              try {
                  mpxSocket.close();
              } catch(e) { }
              mpxSocket = null;
          }

          const socket = new WebSocket(websocketURL);
          mpxSocket = socket; // Save reference
      
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
              if (typeof message.peak === "number") {
                  mpxPeakVal = message.peak;
                  pilotPeakVal = (typeof message.pilotKHz === "number") ? message.pilotKHz : (message.pilot || 0);
                  rdsPeakVal   = (typeof message.rdsKHz === "number") ? message.rdsKHz : (message.rds || 0);
                  noiseFloorVal = message.noise || 0.000001; 
                  hasTimeDomainData = true;
              } else {
                  hasTimeDomainData = false;
              }
              
              handleMpxArray(message.value);
              return;
            }
          };
        }
      
        function initMeters(levelMeterContainer) {
          // Reset all values on start
          if (window.MetricsMeters && typeof window.MetricsMeters.resetValues === "function") {
              window.MetricsMeters.resetValues();
          }

          const container = levelMeterContainer;
          if (!container) return;
      
          container.innerHTML = "";
      
          const stereoGroup = document.createElement("div");
          stereoGroup.classList.add("stereo-group");
          
          createLevelMeter("left-meter",  "LEFT",  stereoGroup, scales.left);
          createLevelMeter("right-meter", "RIGHT", stereoGroup, scales.right);
      
          container.appendChild(stereoGroup);
      
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
      
        window.MetricsMeters = {
          levels,
          updateMeter,
          initMeters,
          
          // Enhanced Reset function
          resetValues() {
              mpxDisplayValue = 0;
              mpxPeakHold = 0;
              mpxInputSmooth = 0;
              levels.mpxTotal = 0;
              levels.stereoPilot = 0;
              levels.rds = 0;
              pilotSmooth = 0;
              
              // RDS Reset
              rdsDisplay = 0;
              rdsLongPrev = 0;
              rdsSigSmooth = 0;
              rdsNoiseSmooth = 0;
              rdsInitialized = false;
              rdsMedianBuf.length = 0;
              isRdsGateOpen = false;

              // Server Peaks Reset
              mpxPeakVal = 0;
              pilotPeakVal = 0;
              rdsPeakVal = 0;
          },

          setStereoStatus(isActive) { websocketStereoActive = !!isActive; },
          setRdsStatus(isActive) { websocketRdsActive = !!isActive; },
          getStereoBoost() { return stereoBoost; },
          setStereoBoost(value) {},
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
            if (!unit) return;
            hfUnit = unit.toLowerCase();
            const meterEl = document.getElementById("hf-meter");
            if (!meterEl) return;
            const levelMeter = meterEl.closest(".level-meter");
            if (!levelMeter) return;
            const scaleEl = levelMeter.querySelector(".meter-scale");
            if (!scaleEl) return;
            const newScale = buildHFScale(hfUnit);
            const ticks = scaleEl.querySelectorAll("div");
            newScale.forEach((txt, idx) => {
              if (ticks[idx]) {
                ticks[idx].innerText = txt;
              }
            });
            if (typeof levels.hfBase === "number") {
              const displayHF = hfBaseToDisplay(levels.hfBase);
              levels.hfValue = displayHF;
            }
          }
        };
      })();