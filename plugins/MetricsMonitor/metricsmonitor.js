///////////////////////////////////////////////////////////////
//                                                           //
//  METRICSMONITOR CLIENT SCRIPT FOR FM-DX-WEBSERVER (V1.3)  //
//                                                           //
//  by Highpoint               last update: 11.12.2025       //
//                                                           //
//  Thanks for support by Jeroen Platenkamp, Bkram, Wötkylä  //
//                                                           //
//  https://github.com/Highpoint2000/metricsmonitor          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {
const sampleRate = 48000;    // Do not touch - auto-updated via config
const stereoBoost = 1;       // Do not touch - auto-updated via config
const eqBoost = 1;           // Do not touch - auto-updated via config
const fftSize = 512;         // Do not touch - auto-updated via config
const SpectrumAttackLevel = 3;   // Do not touch - auto-updated via config
const SpectrumDecayLevel = 15;   // Do not touch - auto-updated via config
const minSendIntervalMs = 30;    // Do not touch - auto-updated via config
const pilotCalibration = 2;      // Do not touch - auto-updated via config
const mpxCalibration = 54;       // Do not touch - auto-updated via config
const rdsCalibration = 1.25;     // Do not touch - auto-updated via config
const CurveYOffset = -40;        // Do not touch - auto-updated via config
const CurveYDynamics = 1.9;      // Do not touch - auto-updated via config
const MPXmode = "auto";          // Do not touch - auto-updated via config
const MPXStereoDecoder = "off";  // Do not touch - auto-updated via config
const MPXInputCard = "";         // Do not touch - auto-updated via config
const LockVolumeSlider = true;   // Do not touch - auto-updated via config
const MODULE_SEQUENCE = [1,2,0,3,4]; // Do not touch - auto-updated via config

// ---------------------------------------------------------
// Simple structured logger
// ---------------------------------------------------------
window.MetricsMonitor = window.MetricsMonitor || {};
window.MetricsMonitor._logBuffer = window.MetricsMonitor._logBuffer || [];

const LOG_MAX_ENTRIES = 500;
const LOG_PREFIX = '[MetricsMonitor]';

function mmLog(level, message, obj) {
  const ts = new Date().toISOString();
  const entry = { ts, level, message, obj };
  window.MetricsMonitor._logBuffer.push(entry);
  if (window.MetricsMonitor._logBuffer.length > LOG_MAX_ENTRIES) {
    window.MetricsMonitor._logBuffer.shift();
  }
  const formatted = `${LOG_PREFIX} ${ts} - ${message}`;
  if (obj !== undefined) {
    if (level === 'error') console.error(formatted, obj);
    else if (level === 'warn') console.warn(formatted, obj);
    else console.log(formatted, obj);
  } else {
    if (level === 'error') console.error(formatted);
    else if (level === 'warn') console.warn(formatted);
    else console.log(formatted);
  }
}

window.MetricsMonitor.getLogs = () => window.MetricsMonitor._logBuffer.slice();
window.MetricsMonitor.clearLogs = () => { window.MetricsMonitor._logBuffer = []; mmLog('log', 'Log buffer cleared'); };

mmLog('log', 'Logger initialized');

// ---------------------------------------------------------
// Plugin version + update check configuration
// ---------------------------------------------------------
const plugin_version = '1.3';
const updateInfo     = true;

const plugin_name = 'MetricsMonitor';
const plugin_path = 'https://raw.githubusercontent.com/Highpoint2000/MetricsMonitor/';
const plugin_JSfile = 'main/plugins/MetricsMonitor/metricsmonitor.js';

const CHECK_FOR_UPDATES     = updateInfo;
const pluginSetupOnlyNotify = true;
const pluginName            = plugin_name;
const pluginHomepageUrl     = 'https://github.com/Highpoint2000/MetricsMonitor/releases';
const pluginUpdateUrl       = plugin_path + plugin_JSfile;

// ---------------------------------------------------------
// Mode handling
// ---------------------------------------------------------
let START_INDEX = 0;
const ACTIVE_SEQUENCE = Array.isArray(MODULE_SEQUENCE) && MODULE_SEQUENCE.length > 0 ? MODULE_SEQUENCE : [0];
if (START_INDEX < 0 || START_INDEX >= ACTIVE_SEQUENCE.length) START_INDEX = 0;

let mode = ACTIVE_SEQUENCE[START_INDEX];
let modeIndex = START_INDEX;
let isSwitching = false;

// ---------------------------------------------------------
// Global signal unit handling
// ---------------------------------------------------------
let globalSignalUnit = localStorage.getItem("mm_signal_unit") || "dbf";
let signalUnitListeners = [];

window.MetricsMonitor.getSignalUnit = function () { return globalSignalUnit; };

window.MetricsMonitor.setSignalUnit = function (unit) {
  if (!unit) return;
  unit = unit.toLowerCase();
  mmLog('log', 'SET SIGNAL UNIT → ' + unit);
  globalSignalUnit = unit;
  localStorage.setItem("mm_signal_unit", unit);
  signalUnitListeners.forEach(fn => fn(unit));
};

window.MetricsMonitor.onSignalUnitChange = function (fn) {
  if (typeof fn === "function") signalUnitListeners.push(fn);
};

function hookSignalUnitDropdown() {
  const input = document.getElementById("signal-selector-input");
  const options = document.querySelectorAll("#signal-selector .option");

  if (!input || options.length === 0) {
    setTimeout(hookSignalUnitDropdown, 500);
    return;
  }
  input.value = globalSignalUnit;
  window.MetricsMonitor.setSignalUnit(globalSignalUnit);
  options.forEach(opt => {
    opt.addEventListener("click", () => {
      const val = opt.dataset.value?.toLowerCase();
      input.value = val;
      window.MetricsMonitor.setSignalUnit(val);
    });
  });
}
setTimeout(hookSignalUnitDropdown, 500);

// ---------------------------------------------------------
// Auto-detect plugin BASE URL
// ---------------------------------------------------------
let BASE_URL = "";
(function detectBase() {
  try {
    let s = document.currentScript;
    if (!s) {
      const list = document.getElementsByTagName("script");
      s = list[list.length - 1];
    }
    if (s && s.src) {
      const src = s.src.split("?")[0].split("#")[0];
      BASE_URL = src.substring(0, src.lastIndexOf("/") + 1);
    }
  } catch (e) {
    mmLog('error', 'Base URL detection failed', e);
  }
})();

function url(file) { return BASE_URL + file.replace(/^\.\//, ""); }

// ---------------------------------------------------------
// Dynamic loading
// ---------------------------------------------------------
function loadCss(file) {
  const href = url(file);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(file) {
  return new Promise((resolve, reject) => {
    const src = url(file);
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = (err) => reject(err);
    document.head.appendChild(el);
  });
}

// ---------------------------------------------------------
// Build module area
// ---------------------------------------------------------
function buildMeters() {
  const meters = document.getElementById("level-meter-container");
  if (!meters) return;
  meters.innerHTML = "";
  mmLog('log', 'MODE = ' + mode);

  if (mode === 0) window.MetricsEqualizer?.init("level-meter-container");
  else if (mode === 1) window.MetricsMeters?.initMeters(meters);
  else if (mode === 2) window.MetricsAnalyzer?.init("level-meter-container");
  else if (mode === 3) window.MetricsSignalMeter?.init("level-meter-container");
  else if (mode === 4) window.MetricsSignalAnalyzer?.init("level-meter-container");
}

// ---------------------------------------------------------
// TEXT SOCKET
// ---------------------------------------------------------
let TextSocket = null;
let textSocketReady = false;
let liveStereoState = false; // tracked from WebSocket

async function ensureTextSocket() {
  try {
    if (!window.socketPromise) return null;
    TextSocket = await window.socketPromise;
    if (!TextSocket) return null;

    if (!textSocketReady) {
      mmLog('log', 'TextSocket available via socketPromise.');

      TextSocket.addEventListener("message", (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.st !== undefined) {
            const newState = (msg.st === true || msg.st === 1);
            if (liveStereoState !== newState) {
              liveStereoState = newState;
            }
          }
        } catch (e) { /* ignore parse errors */ }
      });

      textSocketReady = true;
    }
    return TextSocket;
  } catch (err) {
    mmLog('error', 'ensureTextSocket() failed', err);
    return null;
  }
}

async function sendTextWebSocketCommand(cmd) {
  const ws = await ensureTextSocket();
  if (!ws) {
    mmLog('error', `Cannot send "${cmd}" – no TextSocket.`);
    return;
  }

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(cmd);
      mmLog('log', `TextSocket → "${cmd}"`);
      if (window.MetricsHeader && typeof window.MetricsHeader.setMonoLockFromMode === "function") {
        window.MetricsHeader.setMonoLockFromMode(cmd);
      }
    } catch (err) {
      mmLog('error', 'Failed sending command', { cmd, err });
    }
  } else {
    setTimeout(() => sendTextWebSocketCommand(cmd), 300);
  }
}

// ---------------------------------------------------------
// MPX sync logic
// ---------------------------------------------------------
let textModeInitialized = false;
let lastSentTextMode = null;
let lastAudioMonoState = null; // true=Mono, false=Stereo

function getCurrentAudioStateIsMono() {
  // 1) Prefer MetricsHeader
  if (window.MetricsHeader && typeof window.MetricsHeader.getStereoStatus === 'function') {
    const isStereo = window.MetricsHeader.getStereoStatus();
    mmLog('log', `State via MetricsHeader: isStereo=${isStereo}`);
    return !isStereo;
  }
  // 2) Fallback to tracked WebSocket state
  if (textSocketReady) {
    mmLog('log', `State via WebSocket tracking: isStereo=${liveStereoState}`);
    return !liveStereoState;
  }
  // 3) Final fallback
  mmLog('warn', 'State via fallback (unreliable)');
  return false; // assume stereo
}

function syncTextWebSocketMode(isInitial) {
  let cmd = null;
  mmLog('log', `syncTextWebSocketMode (isInitial=${!!isInitial}, MPXmode=${MPXmode}, mode=${mode})`);

  if (MPXmode === "off") {
    if (!textModeInitialized && isInitial) cmd = "L0";
    else return;
  } else if (MPXmode === "on") {
    if (!textModeInitialized && isInitial) cmd = "L1";
    else return;
  } else {
    // Treat modes 0, 3, 4 as L0 (like equalizer logic); others as L1
    cmd = (mode === 0 || mode === 3 || mode === 4 ? "L0" : "L1");
    if (textModeInitialized && cmd === lastSentTextMode) return;
  }

  if (!cmd) return;

  mmLog('log', `Preparing command "${cmd}"`);

  if (cmd === "L1") {
    const isMono = getCurrentAudioStateIsMono();
    lastAudioMonoState = isMono;

    mmLog('log', `Switching TO MPX. Recorded: ${isMono ? 'MONO' : 'STEREO'}`);

    sendTextWebSocketCommand(cmd);
    setTimeout(() => {
      mmLog('log', 'Sending B2 (MPX Audio)');
      sendTextWebSocketCommand("B2");
    }, 50);

  } else if (cmd === "L0") {
    mmLog('log', 'Switching BACK to L0.');
    sendTextWebSocketCommand(cmd);

    if (lastAudioMonoState !== null) {
      const restoreCmd = lastAudioMonoState ? "B1" : "B0";
      setTimeout(() => {
        mmLog('log', `Restoring Audio State: ${restoreCmd} (${lastAudioMonoState ? 'Mono' : 'Stereo'})`);
        sendTextWebSocketCommand(restoreCmd);
        lastAudioMonoState = null;
      }, 80);
    } else {
      mmLog('warn', 'No recorded state; defaulting to Stereo (B0).');
      setTimeout(() => sendTextWebSocketCommand("B0"), 80);
    }
  }

  textModeInitialized = true;
  lastSentTextMode = cmd;
}

// ---------------------------------------------------------
// Switching & Panel logic
// ---------------------------------------------------------
function switchModeWithFade(nextMode) {
  const meters = document.getElementById("level-meter-container");
  if (!meters) {
    mode = nextMode;
    buildMeters();
    syncTextWebSocketMode(false);
    return;
  }
  if (isSwitching) return;

  const FADE_MS = 150;
  isSwitching = true;
  meters.style.transition = `opacity ${FADE_MS}ms ease-in-out`;
  if (!meters.style.opacity) meters.style.opacity = "1";
  void meters.offsetWidth;
  meters.style.opacity = "0";

  setTimeout(() => {
    mode = nextMode;
    buildMeters();
    syncTextWebSocketMode(false);
    void meters.offsetWidth;
    meters.style.opacity = "1";
    setTimeout(() => { isSwitching = false; }, FADE_MS);
  }, FADE_MS);
}

function attachToggle() {
  const container = document.getElementById("level-meter-container");
  if (!container) return;
  if (ACTIVE_SEQUENCE.length <= 1) {
    container.style.cursor = "default";
    return;
  }
  container.style.cursor = "pointer";
  container.addEventListener("click", () => {
    modeIndex = (modeIndex + 1) % ACTIVE_SEQUENCE.length;
    switchModeWithFade(ACTIVE_SEQUENCE[modeIndex]);
  });
}

// Hotkeys: digits 1..9 map to ACTIVE_SEQUENCE indices (1→0, 2→1, ...)
function attachHotkeys() {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

    const n = parseInt(e.key, 10);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;

    const idx = n - 1;
    if (idx >= ACTIVE_SEQUENCE.length) return;

    modeIndex = idx;
    switchModeWithFade(ACTIVE_SEQUENCE[modeIndex]);
  });
}

function lockVolumeControls(retry = 0) {
  if (!LockVolumeSlider) return;
  const MAX_RETRIES = 10;
  const slider = document.getElementById("volumeSlider");
  if (slider) {
    slider.value = "1";
    slider.disabled = true;
  } else if (retry < MAX_RETRIES) {
    setTimeout(() => lockVolumeControls(retry + 1), 500);
  }
  if (window.Stream?.Fallback?.Player?.Amplification?.gain) {
    try { Stream.Fallback.Player.Amplification.gain.value = 1.0; } catch (e) {}
  } else if (retry < MAX_RETRIES) {
    setTimeout(() => lockVolumeControls(retry + 1), 500);
  }
}

// Tooltip control
let tooltipShownOnce = false;
let tooltipTimeout;

function insertPanel() {
  const panels = document.querySelectorAll(".flex-container .panel-33.no-bg-phone");
  if (panels.length < 3) return;
  const panel = panels[2];
  panel.id = "signalPanel";
  panel.innerHTML = "";
  panel.style.cssText = `position: relative; min-height: 235px; height: 235px; padding: 10px; display: flex; flex-direction: column; justify-content: flex-start; gap: 6px; margin-top: -88px; overflow: hidden; align-items: stretch;`;

  const icons = document.createElement("div");
  icons.id = "signal-icons";
  icons.style.position = "absolute";
  panel.appendChild(icons);
  if (window.innerWidth < 768) icons.style.marginLeft = "14px";
  else icons.style.marginLeft = "-8px";

  if (window.MetricsHeader?.initHeader) MetricsHeader.initHeader(icons);

  const meters = document.createElement("div");
  meters.id = "level-meter-container";
  meters.style.opacity = "1";
  meters.style.marginTop = "25px";
  meters.style.width = "102%";
  meters.style.cursor = "pointer";
  panel.appendChild(meters);

  // Custom tooltip styled via CSS variables
  const customTooltip = document.createElement('div');
  
  // Create dynamic string for tooltip (e.g., "1,2,3,4,5")
  const activeKeys = ACTIVE_SEQUENCE.map((_, index) => index + 1).join(",");
  customTooltip.textContent = "Click here or a number " + activeKeys + " to change the display mode.";
  
  customTooltip.style.cssText = `
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 6px 15px;
    border-radius: 15px;
    background-color: var(--color-2);
    border: 2px solid color-mix(in srgb, var(--color-3) 100%, white 5%);
    color: #FFFFFF;
    font-family: Arial, sans-serif;
    font-size: 13px;
    z-index: 1000;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.3s, visibility 0.3s;
    white-space: normal;
    max-width: 240px;
    text-align: center;
  `;
  panel.appendChild(customTooltip);

  // Tooltip shows once on first hover, then hides after 2s
  meters.addEventListener('mouseenter', () => {
    if (!tooltipShownOnce) {
      clearTimeout(tooltipTimeout);

      customTooltip.style.opacity = '1';
      customTooltip.style.visibility = 'visible';

      tooltipTimeout = setTimeout(() => {
        customTooltip.style.opacity = '0';
        customTooltip.style.visibility = 'hidden';
      }, 3000);

      tooltipShownOnce = true;
    }
  });

  buildMeters();

  ensureTextSocket().then(() => {
    syncTextWebSocketMode(true);
  });

  attachToggle();
  attachHotkeys(); // enable keyboard switching
}

// ---------------------------------------------------------
// Cleanup tweaks
// ---------------------------------------------------------
function cleanup() {
  const flags = document.getElementById("flags-container-desktop");
  if (flags) flags.style.visibility = "hidden";
  function remove() {
    document.querySelector(".data-pty.text-color-default")?.remove();
    document.querySelector("h3.color-4.flex-center")?.remove();
  }
  remove();
  new MutationObserver(remove).observe(document.body, { childList: true, subtree: true });
}

// ---------------------------------------------------------
// Volume slider lock styling
// ---------------------------------------------------------
if (LockVolumeSlider) {
  const style = document.createElement("style");
  style.innerHTML = `#volumeSlider { opacity: 0.4 !important; pointer-events: none !important; }`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------
// Update check
// ---------------------------------------------------------
function checkUpdate(setupOnly, pluginName, urlUpdateLink, urlFetchLink) {
  const isSetupPath = (window.location.pathname || "/").indexOf("/setup") >= 0;
  let ver = typeof plugin_version !== "undefined" ? plugin_version : "Unknown";

  fetch(urlFetchLink, {cache: "no-store"}).then(r => r.text()).then(txt => {
    let remoteVer = "Unknown";
    const match = txt.match(/const\s+plugin_version\s*=\s*['"]([^'"]+)['"]/);
    if(match) remoteVer = match[1];

    if(remoteVer !== "Unknown" && remoteVer !== ver) {
      mmLog('log', `Update available: ${ver} -> ${remoteVer}`);
      if(!setupOnly || isSetupPath) {
        const settings = document.getElementById("plugin-settings");
        if(settings) {
          settings.innerHTML += `<br><a href="${urlUpdateLink}" target="_blank">[${pluginName}] Update: ${ver} -> ${remoteVer}</a>`;
        }
        const updateIcon =
          document.querySelector('.wrapper-outer #navigation .sidenav-content .fa-puzzle-piece')
          || document.querySelector('.wrapper-outer .sidenav-content')
          || document.querySelector('.sidenav-content');

        if (updateIcon) {
          const redDot = document.createElement('span');
          redDot.style.cssText = `
            display: block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background-color: #FE0830;
            margin-left: 82px;
            margin-top: -12px;
          `;
          updateIcon.appendChild(redDot);
        }
      }
    }
  }).catch(e => { mmLog('error', `Update check for ${pluginName} failed`, e); });
}

// ---------------------------------------------------------
// Start
// ---------------------------------------------------------
function start() {
  mmLog('log', 'Starting...');
  loadCss("css/metricsmonitor.css");
  loadCss("css/metricsmonitor_header.css");
  loadCss("css/metricsmonitor_meters.css");
  loadCss("css/metricsmonitor-equalizer.css");
  loadCss("css/metricsmonitor-analyzer.css");
  loadCss("css/metricsmonitor-signalmeter.css");
  loadCss("css/metricsmonitor-signal-analyzer.css");

  Promise.all([
    loadScript("js/metricsmonitor-header.js"),
    loadScript("js/metricsmonitor-meters.js"),
    loadScript("js/metricsmonitor-equalizer.js"),
    loadScript("js/metricsmonitor-analyzer.js"),
    loadScript("js/metricsmonitor-signalmeter.js"),
    loadScript("js/metricsmonitor-signal-analyzer.js")
  ]).then(() => {
    insertPanel();
    cleanup();
    lockVolumeControls();
  }).catch(err => mmLog('error', 'Load error', err));
}

if (CHECK_FOR_UPDATES) checkUpdate(pluginSetupOnlyNotify, pluginName, pluginHomepageUrl, pluginUpdateUrl);

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

})();