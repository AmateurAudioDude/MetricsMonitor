///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-analyzer.js						 (V1.4)  //
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
const SpectrumAverageLevel = 15;    // Do not touch - this value is automatically updated via the config file
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
/////////////////////////////////////////////////////////////////
// Shared WebSocket Hub (One connection for N renderers)
/////////////////////////////////////////////////////////////////
const currentURL = window.location;
const PORT = currentURL.port || (currentURL.protocol === "https:" ? "443" : "80");
const protocol = currentURL.protocol === "https:" ? "wss:" : "ws:";
const HOST = currentURL.hostname;
const WS_URL = `${protocol}//${HOST}:${PORT}/data_plugins`;

let ws = null;
let wsCleaned = false;

const MpxHub = (() => {
  let reconnectTimer = null;
  const listeners = new Set();

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(WS_URL);
      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (!msg || typeof msg !== "object" || msg.type !== "MPX" || !Array.isArray(msg.value)) return;
        listeners.forEach(fn => {
          try { fn(msg.value); } catch (e) { /* ignore */ }
        });
      };
      ws.onclose = () => scheduleReconnect();
      ws.onerror = () => scheduleReconnect();
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (wsCleaned) {
        // return only if mode has changed to prevent reconnect timer from running
        ws = null;
        wsCleaned = false;
        return;
    }
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2500);
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    connect();
    return () => listeners.delete(fn);
  }

  return { subscribe, connect };
})();

function closeMpxSocket() {
  if (ws) {
    try {
      ws.close();
      wsCleaned = true;
    } catch (e) {
      console.error("[MetricsMeters] Error closing WebSocket:", e);
    }
    ws = null;
  }
}

/////////////////////////////////////////////////////////////////
// Keyboard Hub (Attach once, dispatch to active instance)
/////////////////////////////////////////////////////////////////
const KeyboardHub = (() => {
  let installed = false;
  let active = null;

  function setActive(instance) { active = instance; }
  function installOnce() {
    if (installed) return;
    installed = true;

    window.addEventListener("keydown", (e) => {
      if (!active) return;
      active._onGlobalKeyDown?.(e);
    }, { passive: false });

    window.addEventListener("keyup", (e) => {
      if (!active) return;
      active._onGlobalKeyUp?.(e);
    }, { passive: false });
  }

  return { installOnce, setActive };
})();

/////////////////////////////////////////////////////////////////
// Instance Implementation (No global state)
/////////////////////////////////////////////////////////////////
let __mmAnalyzerSeq = 0;
const __instances = new Map();

function createAnalyzerInstance(containerId = "level-meter-container", options = {}) {
  const id = (++__mmAnalyzerSeq);
  const instanceKey = String(options.instanceKey || id);

  // DOM Handling
  const parent = document.getElementById(containerId);
  if (!parent) return null;
  parent.innerHTML = "";

  const block = document.createElement("div");
  block.style.cssText = "display:block; margin:0; padding:0; width:100%; height:100%;";

  // ---------------------------------------------------------
  // Standalone vs Embedded Styling
  // - Standalone: use legacy IDs for CSS compatibility
  // - Embedded: use unique IDs and inline sizing
  // ---------------------------------------------------------
  const embedded = !!options.embedded;
  const wantLegacyCss = !embedded && (options.useLegacyCss !== false);

  const wrap = document.createElement("div");
  wrap.dataset.mmAnalyzerWrap = "1";

  // Use legacy IDs only if safe
  const legacyOk = wantLegacyCss && !document.getElementById("mpxCanvasContainer") && !document.getElementById("mpxCanvas");
  wrap.id = legacyOk ? "mpxCanvasContainer" : `mpxCanvasContainer-${instanceKey}`;

  const canvas = document.createElement("canvas");
  canvas.id = legacyOk ? "mpxCanvas" : `mpxCanvas-${instanceKey}`;

  // Inline styles for embedded mode
  if (embedded) {
    wrap.style.cssText = "width:100%; height:100%; margin:0; padding:0; border:none; border-radius:0; box-shadow:none; overflow:hidden;";
    canvas.style.cssText = "display:block; width:100%; height:100%;";
  }

  wrap.appendChild(canvas);
  block.appendChild(wrap);
  parent.appendChild(block);

  wrap.appendChild(canvas);
  block.appendChild(wrap);
  parent.appendChild(block);

  const ctx = canvas.getContext("2d");

  //////////////////////////////////////////////////////////////////
  // Instance State
  //////////////////////////////////////////////////////////////////
  let mpxSpectrum = [];
  let mpxSmoothSpectrum = [];

  const TOP_MARGIN = 18;
  const BOTTOM_MARGIN = 14;
  const OFFSET_X = 32;
  const Y_STRETCH = 0.8;
  const GRID_X_OFFSET = 30;
  const BASE_SCALE_DB = [-10, -20, -30, -40, -50, -60, -70, -80];

  let MPX_AVERAGE_LEVELS = SpectrumAverageLevel;

  // Defaults
  const MPX_DB_MIN_DEFAULT = -80;
  const MPX_DB_MAX_DEFAULT = 0;

  let MPX_FMAX_HZ = 76000;

  let CURVE_GAIN = 0.5;
  let CURVE_Y_OFFSET_DB = CurveYOffset;
  let CURVE_VERTICAL_DYNAMICS = CurveYDynamics;
  let CURVE_X_STRETCH = 1.40;
  let CURVE_X_SCALE = 1.0;

  let LABEL_CURVE_X_SCALE = 0.9;
  let LABEL_Y_OFFSET = -14;

  // Horizontal Zoom
  let zoomLevel = 1.0;
  let zoomCenterHz = 38000;
  const MIN_ZOOM = 0.68;
  const MAX_ZOOM = 20.0;
  const ZOOM_STEP = 1.3;

  let visibleStartHz = 0;
  let visibleEndHz = MPX_FMAX_HZ;

  // Vertical Zoom
  let zoomLevelY = 1.0;
  let zoomCenterDB = -40;
  const MIN_ZOOM_Y = 1.0;
  const MAX_ZOOM_Y = 5.0;
  const ZOOM_STEP_Y = 1.2;

  let visibleDbMin = MPX_DB_MIN_DEFAULT;
  let visibleDbMax = MPX_DB_MAX_DEFAULT;

  // Drag State
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartCenterHz = 0;
  let dragStartCenterDB = 0;
  let hasDragged = false;

  // Tooltip / Control State
  let magnifierArea = { x: 0, y: 0, width: 0, height: 0 };
  let isHoveringMagnifier = false;
  let tooltipElement = null;
  let ctrlKeyPressed = false;
  let ctrlKeyWasPressed = false;

  // Sample Rate Specific Setup
  let FFT_MAX_HZ = sampleRate / 2;
  if (sampleRate === 48000) {
    CURVE_X_STRETCH = 1.0;
    LABEL_CURVE_X_SCALE = 1.0;
    MPX_FMAX_HZ = 24000;
    zoomCenterHz = 12000;
    FFT_MAX_HZ = 24000;
  }
  if (sampleRate === 96000) {
    CURVE_X_STRETCH = 1.0;
    LABEL_CURVE_X_SCALE = 1.0;
    MPX_FMAX_HZ = 48000;
    zoomCenterHz = 24000;
    FFT_MAX_HZ = 48000;
  }
  if (sampleRate === 192000) {
    FFT_MAX_HZ = 96000;
  }

  visibleStartHz = 0;
  visibleEndHz = MPX_FMAX_HZ;
  visibleDbMin = MPX_DB_MIN_DEFAULT;
  visibleDbMax = MPX_DB_MAX_DEFAULT;

  //////////////////////////////////////////////////////////////////
  // Helper Functions
  //////////////////////////////////////////////////////////////////
  function getDisplayRange() { return { min: visibleDbMin, max: visibleDbMax }; }

  function freqToBin(freqHz, totalBins) {
    const normalizedDisplayX = freqHz / (MPX_FMAX_HZ * LABEL_CURVE_X_SCALE);
    const binIndex = normalizedDisplayX * (totalBins - 1) / CURVE_X_STRETCH;
    return Math.round(Math.max(0, Math.min(totalBins - 1, binIndex)));
  }

  function binToFreq(binIndex, totalBins) {
    const normalizedDisplayX = (binIndex / (totalBins - 1)) * CURVE_X_STRETCH;
    const freqHz = normalizedDisplayX * MPX_FMAX_HZ * LABEL_CURVE_X_SCALE;
    return freqHz;
  }

  function updateZoomBounds() {
    if (zoomLevel >= 1.0) {
      const visibleRangeHz = MPX_FMAX_HZ / zoomLevel;
      visibleStartHz = zoomCenterHz - visibleRangeHz / 2;
      visibleEndHz = zoomCenterHz + visibleRangeHz / 2;

      if (visibleStartHz < 0) {
        visibleStartHz = 0;
        visibleEndHz = visibleRangeHz;
      }
      if (visibleEndHz > MPX_FMAX_HZ) {
        visibleEndHz = MPX_FMAX_HZ;
        visibleStartHz = MPX_FMAX_HZ - visibleRangeHz;
      }
      zoomCenterHz = (visibleStartHz + visibleEndHz) / 2;
    } else {
      visibleStartHz = 0;
      visibleEndHz = MPX_FMAX_HZ;
      zoomCenterHz = MPX_FMAX_HZ / 2;
    }
  }

  function setZoom(newZoomLevel, newCenterHz = null) {
    zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoomLevel));
    if (zoomLevel >= 1.0) {
      if (newCenterHz !== null) zoomCenterHz = Math.max(0, Math.min(MPX_FMAX_HZ, newCenterHz));
    } else {
      zoomCenterHz = MPX_FMAX_HZ / 2;
    }
    updateZoomBounds();
    updateCursor();
    drawMpxSpectrum();
  }

  function updateZoomBoundsY() {
    const totalDbRange = MPX_DB_MAX_DEFAULT - MPX_DB_MIN_DEFAULT;
    const visibleRangeDb = totalDbRange / zoomLevelY;
    visibleDbMin = zoomCenterDB - visibleRangeDb / 2;
    visibleDbMax = zoomCenterDB + visibleRangeDb / 2;

    if (visibleDbMin < MPX_DB_MIN_DEFAULT) {
      visibleDbMin = MPX_DB_MIN_DEFAULT;
      visibleDbMax = MPX_DB_MIN_DEFAULT + visibleRangeDb;
    }
    if (visibleDbMax > MPX_DB_MAX_DEFAULT) {
      visibleDbMax = MPX_DB_MAX_DEFAULT;
      visibleDbMin = MPX_DB_MAX_DEFAULT - visibleRangeDb;
    }
    zoomCenterDB = (visibleDbMin + visibleDbMax) / 2;
  }

  function setZoomY(newZoomLevel, newCenterDB = null) {
    zoomLevelY = Math.max(MIN_ZOOM_Y, Math.min(MAX_ZOOM_Y, newZoomLevel));
    if (newCenterDB !== null) zoomCenterDB = Math.max(MPX_DB_MIN_DEFAULT, Math.min(MPX_DB_MAX_DEFAULT, newCenterDB));
    updateZoomBoundsY();
    updateCursor();
    drawMpxSpectrum();
  }

  function zoomReset() {
    zoomCenterHz = MPX_FMAX_HZ / 2;
    zoomLevel = 1.0;
    updateZoomBounds();

    zoomCenterDB = (MPX_DB_MIN_DEFAULT + MPX_DB_MAX_DEFAULT) / 2;
    zoomLevelY = 1.0;
    updateZoomBoundsY();

    updateCursor();
    drawMpxSpectrum();
  }

  function updateCursor() {
    if (!canvas) return;
    if (isHoveringMagnifier || ctrlKeyPressed) canvas.style.cursor = "help";
    else if (isDragging) canvas.style.cursor = "grabbing";
    else if (zoomLevel > 1.0 || zoomLevelY > 1.0) canvas.style.cursor = "grab";
    else canvas.style.cursor = "pointer";
  }

  //////////////////////////////////////////////////////////////////
  // Tooltip Logic
  //////////////////////////////////////////////////////////////////
  function showTooltip() {
    if (tooltipElement) return;
    tooltipElement = document.createElement("div");
    tooltipElement.id = `mpx-zoom-tooltip-${instanceKey}`;
    tooltipElement.innerHTML = `
      <div style="margin-bottom: 5px; font-weight: bold;">Spectrum Zoom Controls</div>
      <div style="margin-bottom: 4px;">• Scroll wheel: Horizontal zoom (frequency)</div>
      <div style="margin-bottom: 4px;">• Ctrl + Scroll wheel: Vertical zoom (dB)</div>
      <div style="margin-bottom: 4px;">• Left-click + Drag: Pan spectrum</div>
      <div style="margin-bottom: 4px;">• Right-click: Reset zoom</div>
      <div style="margin-top: 5px; border-top: 1px solid rgba(143, 234, 255, 0.2); padding-top: 5px;"></div>
      <div style="margin-bottom: 4px;">• Hold Ctrl + Arrow Up/Down: Zoom in / out</div>
      <div style="margin-bottom: 4px;">• Hold Ctrl + Arrow Left/Right: Pan left / right</div>
      <div style="margin-bottom: 4px;">• Ctrl + Space: Reset zoom</div>
    `;
    tooltipElement.style.cssText = `
      position: absolute;
      background: linear-gradient(to bottom, rgba(0, 40, 70, 0.95), rgba(0, 25, 50, 0.95));
      border: 1px solid rgba(143, 234, 255, 0.5);
      border-radius: 8px;
      padding: 12px 16px;
      color: #8feaff;
      font-family: Arial, sans-serif;
      font-size: 10px;
      line-height: 1.2;
      z-index: 10000;
      pointer-events: none;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      opacity: 0;
      transition: opacity 0.2s ease-in-out;
      max-width: 320px;
      white-space: nowrap;
    `;

    const parentEl = canvas.parentElement;
    if (!parentEl) return;
    parentEl.style.position = "relative";
    parentEl.appendChild(tooltipElement);

    const tooltipWidth = 320;
    const tooltipLeft = (canvas.clientWidth - tooltipWidth) / 2;
    const tooltipTop = (magnifierArea.y || 0) - 170;

    tooltipElement.style.left = `${Math.max(5, tooltipLeft)}px`;
    tooltipElement.style.top = `${Math.max(5, tooltipTop)}px`;

    requestAnimationFrame(() => {
      if (tooltipElement) tooltipElement.style.opacity = "1";
    });
  }

  function hideTooltip() {
    if (!tooltipElement) return;
    tooltipElement.style.opacity = "0";
    setTimeout(() => {
      tooltipElement?.parentElement?.removeChild(tooltipElement);
      tooltipElement = null;
    }, 200);
  }

  //////////////////////////////////////////////////////////////////
  // Drawing Functions
  //////////////////////////////////////////////////////////////////
  function drawMpxBackground() {
    const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grd.addColorStop(0, "#001225");
    grd.addColorStop(1, "#002044");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawMagnifierIcon() {
    const x = canvas.clientWidth / 2;
    const y = canvas.clientHeight - 13;
    magnifierArea = { x: x - 10, y: y - 10, width: 20, height: 16 };
    const color = "rgba(143, 234, 255, 0.8)";
    ctx.save();
    ctx.font = "11px Arial";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("1.0x", x, y);
    ctx.restore();
  }

  function generateFrequencyMarkers() {
    const visibleRange = visibleEndHz - visibleStartHz;
    let step;
    if (visibleRange > 50000) step = 19000;
    else if (visibleRange > 20000) step = 10000;
    else if (visibleRange > 10000) step = 5000;
    else if (visibleRange > 5000) step = 2000;
    else if (visibleRange > 2000) step = 1000;
    else step = 500;

    const markers = [];
    const startMarker = Math.ceil(visibleStartHz / step) * step;
    for (let f = startMarker; f <= visibleEndHz; f += step) {
      if (f === 0) continue;
      const label = f >= 1000 ? (f / 1000).toFixed(f % 1000 === 0 ? 0 : 1) + "k" : String(f);
      markers.push({ f, label });
    }
    return markers;
  }

  function generateDbMarkers() {
    const visibleRange = visibleDbMax - visibleDbMin;
    let step;
    if (visibleRange > 60) step = 10;
    else if (visibleRange > 30) step = 10;
    else if (visibleRange > 15) step = 5;
    else if (visibleRange > 8) step = 2;
    else step = 1;

    const markers = [];
    const startMarker = Math.ceil(visibleDbMin / step) * step;
    for (let db = startMarker; db <= visibleDbMax; db += step) markers.push(db);
    return markers;
  }

  function drawMpxGrid() {
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.font = "10px Arial";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const headerY = TOP_MARGIN - 6;

    const baseMarkers = [
      { f: 19000, label: "19k" }, { f: 38000, label: "38k" },
      { f: 57000, label: "57k" }, { f: 76000, label: "76k" },
      { f: 95000, label: "95k" },
    ];
    const markers = zoomLevel > 1 ? generateFrequencyMarkers() : baseMarkers;

    ctx.font = "11px Arial";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    const gridTopY = TOP_MARGIN;
    const gridBottomY = canvas.height - BOTTOM_MARGIN;

    markers.forEach(m => {
      let x;
      if (zoomLevel > 1) {
        if (m.f < visibleStartHz || m.f > visibleEndHz) return;
        const normalizedPos = (m.f - visibleStartHz) / (visibleEndHz - visibleStartHz);
        x = GRID_X_OFFSET + normalizedPos * (canvas.width - GRID_X_OFFSET);
      } else {
        const horizontalScale = zoomLevel;
        x = GRID_X_OFFSET +
          (m.f / (MPX_FMAX_HZ * LABEL_CURVE_X_SCALE)) *
          (canvas.width - GRID_X_OFFSET) * horizontalScale;
      }
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(x, gridTopY);
      ctx.lineTo(x, gridBottomY);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(m.label, x, headerY);
    });

    const range = getDisplayRange();
    const usableHeight = canvas.height - TOP_MARGIN - BOTTOM_MARGIN;
    const dbMarkers = generateDbMarkers();
    dbMarkers.forEach(v => {
      if (v < visibleDbMin || v > visibleDbMax) return;
      const norm = (v - range.min) / (range.max - range.min);
      const y = TOP_MARGIN + (1 - norm) * usableHeight * Y_STRETCH;
      if (y >= TOP_MARGIN && y <= canvas.height - BOTTOM_MARGIN) {
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(`${v}`, OFFSET_X - 6, y + 10 + LABEL_Y_OFFSET);
      }
    });
  }

  function drawMpxSpectrumTrace() {
    if (!mpxSpectrum.length) return;
    const range = getDisplayRange();
    const usableHeight = canvas.height - TOP_MARGIN - BOTTOM_MARGIN;
    ctx.beginPath();
    ctx.strokeStyle = "#8feaff";
    ctx.lineWidth = 1.0;

    if (zoomLevel > 1) {
      const usableWidth = canvas.width - OFFSET_X;
      const totalBins = mpxSpectrum.length;
      const startBin = freqToBin(visibleStartHz, totalBins);
      const endBin = freqToBin(visibleEndHz, totalBins);
      let firstPoint = true;

      for (let i = startBin; i <= endBin; i++) {
        const binFreq = binToFreq(i, totalBins);
        const normalizedX = (binFreq - visibleStartHz) / (visibleEndHz - visibleStartHz);
        const x = OFFSET_X + normalizedX * usableWidth;

        let rawVal = mpxSpectrum[i];
        let val = (rawVal * CURVE_GAIN) + CURVE_Y_OFFSET_DB;
        val = MPX_DB_MIN_DEFAULT + (val - MPX_DB_MIN_DEFAULT) * CURVE_VERTICAL_DYNAMICS;
        if (val < MPX_DB_MIN_DEFAULT) val = MPX_DB_MIN_DEFAULT;
        if (val > MPX_DB_MAX_DEFAULT) val = MPX_DB_MAX_DEFAULT;

        const norm = (val - range.min) / (range.max - range.min);
        const y = TOP_MARGIN + (1 - norm) * usableHeight * Y_STRETCH;

        if (firstPoint) { ctx.moveTo(x, y); firstPoint = false; }
        else ctx.lineTo(x, y);
      }
    } else {
      const horizontalScale = zoomLevel;
      const usableWidth = (canvas.width - OFFSET_X) * CURVE_X_SCALE;
      const leftStart = OFFSET_X;
      for (let i = 0; i < mpxSpectrum.length; i++) {
        let rawVal = mpxSpectrum[i];
        let val = (rawVal * CURVE_GAIN) + CURVE_Y_OFFSET_DB;
        val = MPX_DB_MIN_DEFAULT + (val - MPX_DB_MIN_DEFAULT) * CURVE_VERTICAL_DYNAMICS;
        if (val < MPX_DB_MIN_DEFAULT) val = MPX_DB_MIN_DEFAULT;
        if (val > MPX_DB_MAX_DEFAULT) val = MPX_DB_MAX_DEFAULT;
        const norm = (val - range.min) / (range.max - range.min);
        const y = TOP_MARGIN + (1 - norm) * usableHeight * Y_STRETCH;
        const x = leftStart + ((i / (mpxSpectrum.length - 1)) * usableWidth * CURVE_X_STRETCH) * horizontalScale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }

  function drawMpxSpectrum() {
    if (!ctx || !canvas) return;
    
    // Use logical dimensions for HiDPI text placement
    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    updateZoomBounds();
    updateZoomBoundsY();
    drawMpxBackground();
    drawMpxGrid();
    drawMpxSpectrumTrace();

    const spectrumName = sampleRate === 48000 ? "FM Audio Spectrum"
      : sampleRate === 96000 ? "FM Baseband Spectrum"
      : sampleRate === 192000 ? "MPX Spectrum"
      : "Spectrum Analyzer";

    ctx.font = "12px Arial";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    
    ctx.fillText(spectrumName, 8, logicalHeight - 10);
    
    ctx.textAlign = "right";
    ctx.fillText(sampleRate + " Hz", logicalWidth - 8, logicalHeight - 10);

    if (zoomLevel !== 1.0 || zoomLevelY > 1.0) {
      let infoText = "";
      if (zoomLevel !== 1.0 && zoomLevelY > 1.0) infoText = `X:${zoomLevel.toFixed(1)}x Y:${zoomLevelY.toFixed(1)}x`;
      else if (zoomLevel !== 1.0) infoText = `${zoomLevel.toFixed(1)}x`;
      else infoText = `Y:${zoomLevelY.toFixed(1)}x`;

      ctx.fillStyle = "rgba(143, 234, 255, 0.8)";
      ctx.font = "11px Arial";
      ctx.textAlign = "center";
      ctx.fillText(infoText, logicalWidth / 2, logicalHeight - 10);
    } else {
        drawMagnifierIcon();
    }
  }

  //////////////////////////////////////////////////////////////////
  // Data Handler (per instance)
  //////////////////////////////////////////////////////////////////
  function handleMpxArray(data) {
    if (!canvas || !canvas.isConnected) return;
    if (!Array.isArray(data) || data.length === 0) return;

    const arr = [];
    for (let i = 0; i < data.length; i++) {
      // Support both old format {f, m} and new format (just magnitude number)
      // This provides backward compatibility with older server versions
      const mag = (typeof data[i] === 'number') ? data[i] : (data[i]?.m || 0);
      let db = 20 * Math.log10(mag + 1e-15);
      if (db < MPX_DB_MIN_DEFAULT) db = MPX_DB_MIN_DEFAULT;
      if (db > MPX_DB_MAX_DEFAULT) db = MPX_DB_MAX_DEFAULT;
      arr.push(db);
    }

    if (mpxSmoothSpectrum.length === 0) {
      mpxSmoothSpectrum = new Array(arr.length).fill(MPX_DB_MIN_DEFAULT);
    }

    const len = Math.min(arr.length, mpxSmoothSpectrum.length);
    for (let i = 0; i < len; i++) {
      mpxSmoothSpectrum[i] =
        (mpxSmoothSpectrum[i] * (MPX_AVERAGE_LEVELS - 1) + arr[i]) / MPX_AVERAGE_LEVELS;
    }
    if (arr.length > len) {
      for (let i = len; i < arr.length; i++) mpxSmoothSpectrum[i] = arr[i];
    }

    mpxSpectrum = mpxSmoothSpectrum.slice();
    drawMpxSpectrum();
  }

  //////////////////////////////////////////////////////////////////
  // Resize Handler
  //////////////////////////////////////////////////////////////////
  function resize() {
    if (!canvas || !canvas.parentElement) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : 400;
    const h = rect.height > 0 ? rect.height : 240;

    // Handle HiDPI scaling
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawMpxSpectrum();
  }

  //////////////////////////////////////////////////////////////////
  // Mouse Event Setup
  //////////////////////////////////////////////////////////////////
  function setupMouseEvents() {
    canvas.addEventListener("mouseenter", () => {
      KeyboardHub.setActive(instance);
      updateCursor();
    });

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const wasHovering = isHoveringMagnifier;
      if (zoomLevel === 1.0 && zoomLevelY <= MIN_ZOOM_Y) {
        isHoveringMagnifier =
          mouseX >= magnifierArea.x && mouseX <= magnifierArea.x + magnifierArea.width &&
          mouseY >= magnifierArea.y && mouseY <= magnifierArea.y + magnifierArea.height;
      } else {
        isHoveringMagnifier = false;
      }

      if (isHoveringMagnifier && !wasHovering) showTooltip();
      else if (!isHoveringMagnifier && wasHovering) hideTooltip();
      updateCursor();

      if (!isDragging) return;
      if (Math.abs(e.clientX - dragStartX) > 5 || Math.abs(e.clientY - dragStartY) > 5) hasDragged = true;
      if (!hasDragged) return;
      e.preventDefault();
      e.stopPropagation();

      if (zoomLevel > 1.0) {
        const deltaHz = -(e.clientX - dragStartX) / ((canvas.clientWidth - OFFSET_X) / (visibleEndHz - visibleStartHz));
        zoomCenterHz = dragStartCenterHz + deltaHz;
      }
      if (zoomLevelY > MIN_ZOOM_Y) {
        const deltaDb = (e.clientY - dragStartY) / (((canvas.clientHeight - TOP_MARGIN - BOTTOM_MARGIN) * Y_STRETCH) / (visibleDbMax - visibleDbMin));
        zoomCenterDB = dragStartCenterDB + deltaDb;
      }

      updateZoomBounds();
      updateZoomBoundsY();
      drawMpxSpectrum();
    });

    canvas.addEventListener("mouseleave", () => {
      if (isHoveringMagnifier) {
        isHoveringMagnifier = false;
        hideTooltip();
        drawMpxSpectrum();
      }
      if (isDragging) {
        isDragging = false;
        hasDragged = false;
        updateCursor();
      }
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (isHoveringMagnifier || ctrlKeyPressed) {
        isHoveringMagnifier = false;
        hideTooltip();
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomDelta = e.deltaY > 0 ? 1 / (e.ctrlKey ? ZOOM_STEP_Y : ZOOM_STEP) : (e.ctrlKey ? ZOOM_STEP_Y : ZOOM_STEP);

      if (e.ctrlKey) {
        const normY = (mouseY - TOP_MARGIN) / ((canvas.clientHeight - TOP_MARGIN - BOTTOM_MARGIN) * Y_STRETCH);
        const range = getDisplayRange();
        const dbAtMouse = range.max - normY * (range.max - range.min);
        setZoomY(zoomLevelY * zoomDelta, dbAtMouse);
      } else {
        let freqAtMouse;
        if (zoomLevel > 1) {
          freqAtMouse = visibleStartHz + ((mouseX - OFFSET_X) / (canvas.clientWidth - OFFSET_X)) * (visibleEndHz - visibleStartHz);
        } else {
          const usableWidth = (canvas.clientWidth - OFFSET_X) * CURVE_X_SCALE * zoomLevel;
          const curveWidth = usableWidth * CURVE_X_STRETCH;
          freqAtMouse = ((mouseX - OFFSET_X) / curveWidth) * MPX_FMAX_HZ * LABEL_CURVE_X_SCALE;
        }
        setZoom(zoomLevel * zoomDelta, freqAtMouse);
      }
    }, { passive: false });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || isHoveringMagnifier) return;
      if (zoomLevel <= 1.0 && zoomLevelY <= MIN_ZOOM_Y) return;
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      hasDragged = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartCenterHz = zoomCenterHz;
      dragStartCenterDB = zoomCenterDB;
      updateCursor();
    });

    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0 && isDragging) {
        isDragging = false;
        updateCursor();
        if (hasDragged) e.stopPropagation();
      }
    });

    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      zoomReset();
    });

    canvas.addEventListener("click", (e) => {
      if (isHoveringMagnifier || hasDragged) {
        e.stopPropagation();
        hasDragged = false;
      }
    });
  }

  //////////////////////////////////////////////////////////////////
  // Keyboard Event Handlers (Called by KeyboardHub)
  //////////////////////////////////////////////////////////////////
  function onGlobalKeyDown(e) {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA' || e.target?.isContentEditable) return;

    if (e.key === "Control" && !ctrlKeyWasPressed) {
      ctrlKeyPressed = true;
      ctrlKeyWasPressed = true;
      if (!tooltipElement) showTooltip();
      updateCursor();
    }

    if (!e.ctrlKey) return;

    let handled = false;
    switch (e.key) {
      case "ArrowUp":    setZoom(zoomLevel * ZOOM_STEP, zoomCenterHz); handled = true; break;
      case "ArrowDown":  setZoom(zoomLevel / ZOOM_STEP, zoomCenterHz); handled = true; break;
      case "ArrowLeft":
        if (zoomLevel > 1) {
          const panStep = (visibleEndHz - visibleStartHz) * 0.05;
          setZoom(zoomLevel, zoomCenterHz - panStep);
        }
        handled = true;
        break;
      case "ArrowRight":
        if (zoomLevel > 1) {
          const panStep = (visibleEndHz - visibleStartHz) * 0.05;
          setZoom(zoomLevel, zoomCenterHz + panStep);
        }
        handled = true;
        break;
      case " ":
        zoomReset();
        handled = true;
        break;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      hideTooltip();
    }
  }

  function onGlobalKeyUp(e) {
    if (e.key === "Control") {
      ctrlKeyPressed = false;
      ctrlKeyWasPressed = false;
      hideTooltip();
      updateCursor();
    }
  }

  //////////////////////////////////////////////////////////////////
  // Lifecycle Management
  //////////////////////////////////////////////////////////////////
  const unsubscribe = MpxHub.subscribe(handleMpxArray);

  function destroy() {
    try { unsubscribe?.(); } catch (e) {}
    hideTooltip();
    try { parent.innerHTML = ""; } catch (e) {}
    __instances.delete(instanceKey);
  }

  // Build Instance API
  const instance = {
    id: instanceKey,
    containerId,
    wrap,
    canvas,
    resize,
    zoomReset,
    destroy,
    _onGlobalKeyDown: onGlobalKeyDown,
    _onGlobalKeyUp: onGlobalKeyUp,
  };

  // One-time Setup
  KeyboardHub.installOnce();
  setupMouseEvents();
  __instances.set(instanceKey, instance);

  // Initial Paint
  resize();
  updateZoomBounds();
  updateZoomBoundsY();
  updateCursor();
  drawMpxSpectrum();

  return instance;
}

/////////////////////////////////////////////////////////////////
// Public API (Backward Compatible)
/////////////////////////////////////////////////////////////////
function init(containerId = "level-meter-container", options = {}) {
  // Destroy existing instance if container reused
  const existing = [...__instances.values()].find(i => i.containerId === containerId);
  if (existing) {
    try { existing.destroy(); } catch (e) {}
  }
  return createAnalyzerInstance(containerId, options);
}

function zoomReset(target) {
  if (!target) {
    __instances.forEach(i => i.zoomReset?.());
    return;
  }
  const byKey = __instances.get(String(target));
  if (byKey) return byKey.zoomReset?.();
  const byContainer = [...__instances.values()].find(i => i.containerId === target);
  if (byContainer) return byContainer.zoomReset?.();
}

function resize(target) {
  if (!target) {
    __instances.forEach(i => i.resize?.());
    return;
  }
  const byKey = __instances.get(String(target));
  if (byKey) return byKey.resize?.();
  const byContainer = [...__instances.values()].find(i => i.containerId === target);
  if (byContainer) return byContainer.resize?.();
}

function destroy(target) {
  if (!target) {
    [...__instances.values()].forEach(i => i.destroy?.());
    __instances.clear();
    return;
  }
  const byKey = __instances.get(String(target));
  if (byKey) return byKey.destroy?.();
  const byContainer = [...__instances.values()].find(i => i.containerId === target);
  if (byContainer) return byContainer.destroy?.();
}

// Global Exports
window.MetricsAnalyzer = window.MetricsAnalyzer || { cleanup: closeMpxSocket };
window.MetricsAnalyzer.init = init;
window.MetricsAnalyzer.zoomReset = zoomReset;
window.MetricsAnalyzer.resize = resize;
window.MetricsAnalyzer.destroy = destroy;

})();