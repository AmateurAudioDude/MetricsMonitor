//////////////////////////////////////////////////////////////////
//                                                              //
//  METRICSMONITOR SERVER SCRIPT FOR FM-DX-WEBSERVER  (V1.5)    //
//                                                              //
//  by Highpoint               last update: 04.01.2026          //
//                                                              //
//  Thanks for support by                                       //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude         //
//                                                              //
//  https://github.com/Highpoint2000/metricsmonitor             //
//                                                              //
//////////////////////////////////////////////////////////////////

// ====================================================================================
//  DEBUG CONFIGURATION
//  Set to 'true' to enable detailed logging of MPX/RDS/SNR values to the console.
//  This is useful for calibrating the input levels or debugging signal issues.
// ====================================================================================
const ENABLE_EXTENDED_LOGGING = false;

// ====================================================================================
//  MODULE IMPORTS
//  We need these built-in Node.js modules and external dependencies to function.
// ====================================================================================
const { spawn, execSync } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// Import core server utilities for logging and configuration
// These paths assume the standard file structure of the FM-DX-Webserver
const { logInfo, logError, logWarn } = require("./../../server/console");
const mainConfig = require("./../../config.json");

// ====================================================================================
//  PLUGIN CONFIGURATION MANAGEMENT
//  Handles loading, validating, and normalizing the 'metricsmonitor.json' config file.
// ====================================================================================

// Path to the configuration file
const configFilePath = path.join(
  __dirname,
  "./../../plugins_configs/metricsmonitor.json"
);

/**
 * DEFAULT CONFIGURATION OBJECT
 * These values are used if the config file is missing or specific keys are undefined.
 * The order here reflects the user's requested JSON structure.
 */
const defaultConfig = {
  // 1. Audio & MPX Hardware Settings
  sampleRate: 48000,            // The sample rate for capture (Hz)
  MPXmode: "off",               // Mode switch (off/auto/on)
  MPXStereoDecoder: "off",      // Internal stereo decoder switch
  MPXInputCard: "",             // Input device name (if empty, tries to use 3LAS)

  // 2. Calibration Offsets (Meters)
  MeterInputCalibration: 0.0,   // Input Gain Calibration in dB (applies to MPX METERS only)
  MeterPilotCalibration: 0.0,	// Pilot Calibration in dB
  MeterMPXCalibration: 0.0,     // MPX Calibration in dB
  MeterRDSCalibration: 0.0,     // RDS Calibration in dB

  // 3. FFT / Spectrum Settings
  fftLibrary: "fft-js",         // "fft-js" or "pffft.wasm" (faster)
  fftSize: 512,                 // FFT Window size (resolution)
  
  // 4. Spectrum Visuals
  SpectrumInputCalibration: 0,  // Input Gain Calibration in dB (applies to SPECTRUM only)
  SpectrumAttackLevel: 3,       // Smoothing attack
  SpectrumDecayLevel: 15,       // Smoothing decay
  SpectrumSendInterval: 30,     // WebSocket update rate (approx 30fps)
  "Spectrum-Y-Offset": -40,     // Y-Axis offset for the visual curve
  "Spectrum-Y-Dynamics": 2,     // Dynamic range scaling for the visual curve

  // 5. Meter Gains
  StereoBoost: 2,               // Multiplier for L/R stereo meters
  AudioMeterBoost: 1.0,         // Multiplier for 5-Band audiometer

  // 6. Layout & UI
  MODULE_SEQUENCE: "1,2,0,3,4", // Order of UI modules
  CANVAS_SEQUENCE: "2,4",       // Order of Canvas elements
  LockVolumeSlider: true,       // Lock the main volume slider in UI
  EnableSpectrumOnLoad: false,   // Start spectrum automatically

  // 7. Colors & Peaks
  MeterColorSafe: "rgb(0, 255, 0)",     // RGB Array (Green)
  MeterColorWarning: "rgb(255, 255,0)", // RGB Array (Yellow)
  MeterColorDanger: "rgb(255, 0, 0)",   // RGB Array (Red)
  PeakMode: "dynamic",                  // "dynamic" or "fixed"
  PeakColorFixed: "rgb(251, 174, 38)"   // RGB Color for fixed peak
};

/**
 * NORMALIZE PLUGIN CONFIGURATION
 * Ensures that the loaded JSON object contains all necessary keys.
 * Migrates old/deprecated keys to new names if found.
 */
function normalizePluginConfig(json) {
  // 1. Migration: Rename minSendIntervalMs -> SpectrumSendInterval
  if (typeof json.minSendIntervalMs !== "undefined" && typeof json.SpectrumSendInterval === "undefined") {
    json.SpectrumSendInterval = json.minSendIntervalMs;
    delete json.minSendIntervalMs;
  }
  
  // 2. Migration: Rename Curve-Y-Offset -> Spectrum-Y-Offset
  if (typeof json["Curve-Y-Offset"] !== "undefined" && typeof json["Spectrum-Y-Offset"] === "undefined") {
    json["Spectrum-Y-Offset"] = json["Curve-Y-Offset"];
    delete json["Curve-Y-Offset"];
  }

  // 3. Migration: Rename Curve-Y-Dynamics -> Spectrum-Y-Dynamics
  if (typeof json["Curve-Y-Dynamics"] !== "undefined" && typeof json["Spectrum-Y-Dynamics"] === "undefined") {
    json["Spectrum-Y-Dynamics"] = json["Curve-Y-Dynamics"];
    delete json["Curve-Y-Dynamics"];
  }

  // 4. Migration: Rename stereoBoost -> StereoBoost
  if (typeof json.stereoBoost !== "undefined" && typeof json.StereoBoost === "undefined") {
    json.StereoBoost = json.stereoBoost;
    delete json.stereoBoost;
  }

  // 5. Migration: Rename eqBoost / EqBoost -> AudioMeterBoost
  if (typeof json.AudioMeterBoost === "undefined") {
    if (typeof json.eqBoost !== "undefined") {
      json.AudioMeterBoost = json.eqBoost;
      delete json.eqBoost;
    } else if (typeof json.EqBoost !== "undefined") {
      json.AudioMeterBoost = json.EqBoost;
      delete json.EqBoost;
    }
  }

  // 6. Migration: ExtStereoDecoder -> MPXStereoDecoder
  if (typeof json.ExtStereoDecoder !== "undefined" && typeof json.MPXStereoDecoder === "undefined") {
    json.MPXStereoDecoder = json.ExtStereoDecoder;
    delete json.ExtStereoDecoder; 
  }

  // 7. Migration: MPXinputCalibration/MPXboost -> MeterInputCalibration
  if (typeof json.MeterInputCalibration === "undefined") {
    if (typeof json.MPXinputCalibration !== "undefined") {
        json.MeterInputCalibration = json.MPXinputCalibration;
        delete json.MPXinputCalibration;
    } else if (typeof json.MPXboost !== "undefined") {
        json.MeterInputCalibration = json.MPXboost;
        delete json.MPXboost;
    }
  }

  // 8. Migration: pilotCalibration -> MeterPilotCalibration
  if (typeof json.pilotCalibration !== "undefined" && typeof json.MeterPilotCalibration === "undefined") {
    json.MeterPilotCalibration = json.pilotCalibration;
    delete json.pilotCalibration;
  }

  // 9. Migration: mpxCalibration -> MeterMPXCalibration
  if (typeof json.mpxCalibration !== "undefined" && typeof json.MeterMPXCalibration === "undefined") {
    json.MeterMPXCalibration = json.mpxCalibration;
    delete json.mpxCalibration;
  }

  // 10. Migration: rdsCalibration -> MeterRDSCalibration
  if (typeof json.rdsCalibration !== "undefined" && typeof json.MeterRDSCalibration === "undefined") {
    json.MeterRDSCalibration = json.rdsCalibration;
    delete json.rdsCalibration;
  }
  
  // 11. Migration: CurveInputCalibration -> SpectrumInputCalibration
  if (typeof json.CurveInputCalibration !== "undefined" && typeof json.SpectrumInputCalibration === "undefined") {
    json.SpectrumInputCalibration = json.CurveInputCalibration;
    delete json.CurveInputCalibration;
  }

  // Cleanup: Remove unused keys
  if (typeof json.SpectrumAverageLevel !== "undefined") delete json.SpectrumAverageLevel;
  if (typeof json.DevLimitKHz !== "undefined") delete json.DevLimitKHz;
  if (typeof json.DevRefKHz !== "undefined") delete json.DevRefKHz;
  if (typeof json.DevUncKHz !== "undefined") delete json.DevUncKHz;
  if (typeof json.DevScaleKHzPerAmp !== "undefined") delete json.DevScaleKHzPerAmp;

  // Apply Defaults for missing keys
  const result = {
    sampleRate: typeof json.sampleRate !== "undefined" ? json.sampleRate : defaultConfig.sampleRate,
    MPXmode: typeof json.MPXmode !== "undefined" ? json.MPXmode : defaultConfig.MPXmode,
    MPXStereoDecoder: typeof json.MPXStereoDecoder !== "undefined" ? json.MPXStereoDecoder : defaultConfig.MPXStereoDecoder,
    MPXInputCard: typeof json.MPXInputCard !== "undefined" ? json.MPXInputCard : defaultConfig.MPXInputCard,
    
    MeterInputCalibration: typeof json.MeterInputCalibration !== "undefined" ? json.MeterInputCalibration : defaultConfig.MeterInputCalibration,
    MeterPilotCalibration: typeof json.MeterPilotCalibration !== "undefined" ? json.MeterPilotCalibration : defaultConfig.MeterPilotCalibration,
    MeterMPXCalibration: typeof json.MeterMPXCalibration !== "undefined" ? json.MeterMPXCalibration : defaultConfig.MeterMPXCalibration,
    MeterRDSCalibration: typeof json.MeterRDSCalibration !== "undefined" ? json.MeterRDSCalibration : defaultConfig.MeterRDSCalibration,
    
    fftLibrary: typeof json.fftLibrary !== "undefined" ? json.fftLibrary : defaultConfig.fftLibrary,
    fftSize: typeof json.fftSize !== "undefined" ? json.fftSize : defaultConfig.fftSize,
    
    SpectrumInputCalibration: typeof json.SpectrumInputCalibration !== "undefined" ? json.SpectrumInputCalibration : defaultConfig.SpectrumInputCalibration,
    SpectrumAttackLevel: typeof json.SpectrumAttackLevel !== "undefined" ? json.SpectrumAttackLevel : defaultConfig.SpectrumAttackLevel,
    SpectrumDecayLevel: typeof json.SpectrumDecayLevel !== "undefined" ? json.SpectrumDecayLevel : defaultConfig.SpectrumDecayLevel,
    SpectrumSendInterval: typeof json.SpectrumSendInterval !== "undefined" ? json.SpectrumSendInterval : defaultConfig.SpectrumSendInterval,
    "Spectrum-Y-Offset": typeof json["Spectrum-Y-Offset"] !== "undefined" ? json["Spectrum-Y-Offset"] : defaultConfig["Spectrum-Y-Offset"],
    "Spectrum-Y-Dynamics": typeof json["Spectrum-Y-Dynamics"] !== "undefined" ? json["Spectrum-Y-Dynamics"] : defaultConfig["Spectrum-Y-Dynamics"],
    
    StereoBoost: typeof json.StereoBoost !== "undefined" ? json.StereoBoost : defaultConfig.StereoBoost,
    AudioMeterBoost: typeof json.AudioMeterBoost !== "undefined" ? json.AudioMeterBoost : defaultConfig.AudioMeterBoost,
    
    MODULE_SEQUENCE: typeof json.MODULE_SEQUENCE !== "undefined" ? json.MODULE_SEQUENCE : defaultConfig.MODULE_SEQUENCE,
    CANVAS_SEQUENCE: typeof json.CANVAS_SEQUENCE !== "undefined" ? json.CANVAS_SEQUENCE : defaultConfig.CANVAS_SEQUENCE,
    LockVolumeSlider: typeof json.LockVolumeSlider !== "undefined" ? json.LockVolumeSlider : defaultConfig.LockVolumeSlider,
    EnableSpectrumOnLoad: typeof json.EnableSpectrumOnLoad !== "undefined" ? json.EnableSpectrumOnLoad : defaultConfig.EnableSpectrumOnLoad,
    
    MeterColorSafe: typeof json.MeterColorSafe !== "undefined" ? json.MeterColorSafe : defaultConfig.MeterColorSafe,
    MeterColorWarning: typeof json.MeterColorWarning !== "undefined" ? json.MeterColorWarning : defaultConfig.MeterColorWarning,
    MeterColorDanger: typeof json.MeterColorDanger !== "undefined" ? json.MeterColorDanger : defaultConfig.MeterColorDanger,
    PeakMode: typeof json.PeakMode !== "undefined" ? json.PeakMode : defaultConfig.PeakMode,
    PeakColorFixed: typeof json.PeakColorFixed !== "undefined" ? json.PeakColorFixed : defaultConfig.PeakColorFixed,
  };

  // Preserve any extra custom keys
  for (const key of Object.keys(json)) {
    if (!(key in result)) {
      result[key] = json[key];
    }
  }

  return result;
}

/**
 * LOAD OR CREATE CONFIG FILE
 * Reads the JSON file. If missing or corrupt, creates a new one with defaults.
 * Also handles creating a .bak backup before overwriting.
 * 
 * @param {string} filePath - Absolute path to the config file
 * @returns {Object} - The usable configuration object
 */
function loadConfig(filePath) {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();

      if (raw.length === 0) {
        throw new Error("Empty JSON file");
      }

      let json = JSON.parse(raw);

      if (!json || Object.keys(json).length === 0) {
        throw new Error("Empty JSON object");
      }

      // Normalize
      json = normalizePluginConfig(json);
      
      // CREATE BACKUP BEFORE OVERWRITING
      try {
        const backupPath = filePath + ".bak";
        fs.copyFileSync(filePath, backupPath);
      } catch (backupErr) {
        logWarn(`[MPX] Failed to create config backup: ${backupErr.message}`);
      }

      // Write back with new order/keys
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");

      return json;
    } catch (err) {
      console.error("[MPX CONFIG ERROR] Raw Content was:", fs.readFileSync(filePath, "utf8")); // Zeigt den Inhalt, der Fehler verursacht
      logWarn(
        "[MPX] metricsmonitor.json invalid → rewriting with defaults:",
        err.message
      );
      // Backup defaults
      fs.writeFileSync(
        filePath,
        JSON.stringify(defaultConfig, null, 2),
        "utf8"
      );
      return defaultConfig;
    }
  }

  // File does not exist, create it
  logWarn(
    "[MPX] metricsmonitor.json not found → creating new file with defaults."
  );
  fs.writeFileSync(filePath, JSON.stringify(defaultConfig, null, 2), "utf8");
  return defaultConfig;
}

// Load the configuration now
const configPlugin = loadConfig(configFilePath);

// ====================================================================================
//  CONFIGURATION VALUE EXTRACTION
//  Extract values into const/let variables for cleaner usage in the script.
// ====================================================================================

// Sequences can be arrays or comma-separated strings
let MODULE_SEQUENCE = configPlugin.MODULE_SEQUENCE;
let CANVAS_SEQUENCE = configPlugin.CANVAS_SEQUENCE;

// Sample Rate
const ANALYZER_SAMPLE_RATE = Number(configPlugin.sampleRate) || 192000;
const CONFIG_SAMPLE_RATE = ANALYZER_SAMPLE_RATE;

// Audio processing parameters
const STEREO_BOOST = Number(configPlugin.StereoBoost) || 1.0;
const AUDIO_METER_BOOST = Number(configPlugin.AudioMeterBoost) || 1.0;
const FFT_LIBRARY = String(configPlugin.fftLibrary).trim();
const FFT_SIZE = Number(configPlugin.fftSize) || 4096;
const SPECTRUM_SEND_INTERVAL = Number(configPlugin.SpectrumSendInterval) || 30;

// ====================================================================================
//  CALIBRATION HANDLING (dB to Linear)
// ====================================================================================

// 1. Meters Calibration (MeterInputCalibration)
const METER_INPUT_CALIBRATION_DB = Number(configPlugin.MeterInputCalibration) || 0;
// Convert dB to Linear Gain Factor: Gain = 10^(dB/20)
const METER_GAIN_FACTOR = Math.pow(10, METER_INPUT_CALIBRATION_DB / 20.0);

// 2. Spectrum Calibration (SpectrumInputCalibration)
const SPECTRUM_INPUT_CALIBRATION_DB = Number(configPlugin.SpectrumInputCalibration) || 0;
// Convert dB to Linear Gain Factor for Spectrum
const SPECTRUM_GAIN_FACTOR = Math.pow(10, SPECTRUM_INPUT_CALIBRATION_DB / 20.0);


// Deviation / ITU settings (Hardcoded)
const DEV_LIMIT_KHZ = 75;
const DEV_REF_KHZ = 19;
const DEV_UNC_KHZ = 2;

// Visual settings
const SPECTRUM_ATTACK_LEVEL = Number(configPlugin.SpectrumAttackLevel) || 3;
const SPECTRUM_DECAY_LEVEL = Number(configPlugin.SpectrumDecayLevel) || 15;
const MPX_MODE = String(configPlugin.MPXmode || "auto").toLowerCase();
const MPX_STEREO_DECODER = String(configPlugin.MPXStereoDecoder || "off").toLowerCase();
const MPX_INPUT_CARD = String(configPlugin.MPXInputCard || "").replace(/^["'](.*)["']$/, "$1");
const LOCK_VOLUME_SLIDER = configPlugin.LockVolumeSlider === true;
const ENABLE_SPECTRUM_ON_LOAD = configPlugin.EnableSpectrumOnLoad === true;

// Calibrations
const METER_PILOT_CALIBRATION = Number(configPlugin.MeterPilotCalibration) || 0.0;
const METER_MPX_CALIBRATION = Number(configPlugin.MeterMPXCalibration) || 0.0;
const METER_RDS_CALIBRATION = Number(configPlugin.MeterRDSCalibration) || 0.0;

// Curve adjustments
const SPECTRUM_Y_OFFSET = Number(configPlugin["Spectrum-Y-Offset"]) || -40;
const SPECTRUM_Y_DYNAMICS = Number(configPlugin["Spectrum-Y-Dynamics"]) || 2.0;

// Color & Peak Settings
const METER_COLOR_SAFE = JSON.stringify(configPlugin.MeterColorSafe || "rgb(0, 255, 0)");
const METER_COLOR_WARNING = JSON.stringify(configPlugin.MeterColorWarning || "rgb(255, 255, 0)");
const METER_COLOR_DANGER = JSON.stringify(configPlugin.MeterColorDanger || "rgb(255, 0, 0)");
const PEAK_MODE = String(configPlugin.PeakMode || "dynamic");
const PEAK_COLOR_FIXED = String(configPlugin.PeakColorFixed || "rgb(251, 174, 38)");

// ====================================================================================
//  PATH DEFINITIONS FOR CLIENT FILES
// ====================================================================================
const MetricsMonitorClientFile = path.join(__dirname, "metricsmonitor.js");
const MetricsMonitorClientAnalyzerFile = path.join(
  __dirname,
  "js/metricsmonitor-analyzer.js"
);
const MetricsMonitorClientMetersFile = path.join(
  __dirname,
  "js/metricsmonitor-meters.js"
);
const MetricsMonitorClientAudioMeterFile = path.join(
  __dirname,
  "js/metricsmonitor-audiometer.js"
);
const MetricsMonitorClientHeaderFile = path.join(
  __dirname,
  "js/metricsmonitor-header.js"
);
const MetricsMonitorClientSignalMeterFile = path.join(
  __dirname,
  "js/metricsmonitor-signalmeter.js"
);
const MetricsMonitorClientSignalAnalyzerFile = path.join(
  __dirname,
  "js/metricsmonitor-signal-analyzer.js"
);

/**
 * HELPER: sequenceContainsId
 * Checks if a module ID is present in the sequence string/array.
 */
function sequenceContainsId(seq, id) {
  let arr;
  if (Array.isArray(seq)) {
    arr = seq;
  } else {
    arr = String(seq)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }
  return arr.includes(id);
}

// ------------------------------------------------------------------------------------
//  FEATURE TOGGLES (OPTIMIZATION)
// ------------------------------------------------------------------------------------

// 1. Analyzer (FFT) - Visual Spectrum
// Runs if Module 1 (Analyzer) OR Canvas 2 (MPX Canvas) is present
const ENABLE_FFT = sequenceContainsId(MODULE_SEQUENCE, 1) || 
                   sequenceContainsId(CANVAS_SEQUENCE, 2);

// 2. Goertzel (Math/Meters) - Value Calculation
// Runs if Module 1 (Analyzer/Overlay), Module 2 (Meters), or Canvas 2 is present.
// This ensures that metering data is available when any relevant module is active.
const ENABLE_GOERTZEL = sequenceContainsId(MODULE_SEQUENCE, 1) || 
                        sequenceContainsId(MODULE_SEQUENCE, 2) || 
                        sequenceContainsId(CANVAS_SEQUENCE, 2);

// Master Switch
const ENABLE_MPX = ENABLE_FFT || ENABLE_GOERTZEL;
const ENABLE_ANALYZER = ENABLE_MPX; // Legacy Alias

// ====================================================================================
//  DEPENDENCY MANAGEMENT
//  Ensures that necessary node modules are installed (e.g., fft-js).
// ====================================================================================

const RequiredModules = [
  "fft-js",
  "bit-twiddle",
  // If pffft.wasm is selected, we check it, otherwise we skip
  FFT_LIBRARY === "pffft.wasm" ? "@echogarden/pffft-wasm" : null,
].filter(Boolean);

function ensureRequiredModules() {
  RequiredModules.forEach((moduleName) => {
    const modulePath = path.join(__dirname, "./../../node_modules", moduleName);
    if (!fs.existsSync(modulePath)) {
      logInfo(`[MPX] Module "${moduleName}" is missing. Installing via npm...`);
      try {
        execSync(`npm install ${moduleName}`, { stdio: "inherit" });
        logInfo(`[MPX] Module "${moduleName}" installed successfully.`);
      } catch (error) {
        logError(`[MPX] Error installing module "${moduleName}":`, error);
      }
    }
  });
}

// ====================================================================================
//  SYSTEM PATCHING
//  These functions modify other server files to ensure compatibility.
// ====================================================================================

/**
 * PATCH 3LAS SERVER
 * Modifies '3las.server.js' to respect the 'sampleRate' from config instead of
 * being hardcoded to 48000 Hz (unless on Windows where 48k is forced).
 */
function patch3LAS() {
  try {
    const filePath = path.resolve(
      __dirname,
      "../../server/stream/3las.server.js"
    );
    let content = fs.readFileSync(filePath, "utf8");

    // We look for the standard 3LAS initialization line
    const oldBlockRegex = /const audioChannels[\s\S]*?48000\);/;

    const newBlock = `
const audioChannels = serverConfig.audio.audioChannels || 2;

// Default fallback
let sampleRate = Number(serverConfig.audio.sampleRate) || 48000;

// On Windows we still force 48000 Hz (3LAS limitation / compatibility)
if (process.platform === "win32") {
  sampleRate = 48000;
  logInfo("[Audio Stream] 3LAS on Windows detected → forcing sampleRate = 48000");
} else {
  logInfo("[Audio Stream] 3LAS using sampleRate from serverConfig.audio.sampleRate →", sampleRate);
}

const Server = new StreamServer(null, audioChannels, sampleRate);
    `.trim();

    if (oldBlockRegex.test(content)) {
      content = content.replace(oldBlockRegex, newBlock);
      fs.writeFileSync(filePath, content, "utf8");
      logInfo(
        "[MPX] 3LAS sampleRate block successfully patched. Please restart the webserver."
      );
    } else {
      // It might be already patched or different version
      logInfo(
        "[MPX] 3LAS old sampleRate block not found – no changes applied (possibly already patched)."
      );
    }
  } catch (err) {
    logError("[MPX] Failed to patch 3las.server.js:", err);
  }
}

/**
 * PATCH HELPERS.JS
 * Adds an exemption for Localhost (127.0.0.1) to bypass the Anti-Spam protection.
 * This is critical because the plugin communicates via internal WebSocket on localhost.
 */
const LOCALHOST_PATCH_MARKER = "// MM_LOCALHOST_SPAM_BYPASS:";

function patchHelpersForLocalhostBypass() {
  try {
    const helpersPath = path.join(__dirname, "./../../server/helpers.js");

    if (!fs.existsSync(helpersPath)) {
      logWarn(
        "[MPX] helpers.js not found, cannot patch antispamProtection()."
      );
      return;
    }

    let content = fs.readFileSync(helpersPath, "utf8");

    if (content.includes(LOCALHOST_PATCH_MARKER)) {
      // Already patched
      return;
    }

    // Locate the function
    const fnSignature =
      "function antispamProtection(message, clientIp, ws, userCommands, lastWarn, userCommandHistory, lengthCommands, endpointName) {";
    const fnIndex = content.indexOf(fnSignature);

    if (fnIndex === -1) {
      logWarn(
        "[MPX] antispamProtection() not found in helpers.js – skipping localhost patch."
      );
      return;
    }

    // Locate start of function body
    const commandLine = "const command = message.toString();";
    const cmdIndex = content.indexOf(commandLine, fnIndex);

    if (cmdIndex === -1) {
      logWarn(
        "[MPX] 'const command = message.toString();' not found in antispamProtection() – skipping localhost patch."
      );
      return;
    }

    const insertPos = cmdIndex + commandLine.length;

    const insertion = `
  ${LOCALHOST_PATCH_MARKER} allow internal server apps on localhost
  const isLocalhost =
    clientIp === "127.0.0.1" ||
    clientIp === "::1" ||
    clientIp === "::ffff:127.0.0.1" ||
    (clientIp && clientIp.replace(/^::ffff:/, '') === "127.0.0.1");

  if (isLocalhost) {
    // no spam/bot checks for local server applications
    return command;
  }`;

    content = content.slice(0, insertPos) + insertion + content.slice(insertPos);
    fs.writeFileSync(helpersPath, content, "utf8");

    logInfo(
      "[MPX] helpers.js patched: localhost exempt in antispamProtection(). Please restart the webserver!"
    );
  } catch (err) {
    logWarn(
      `[MPX] Failed to patch helpers.js for localhost exemption: ${err.message}`
    );
  }
}

// ====================================================================================
//  CLIENT-SIDE FILE UPDATES
//  Injects the current server configuration directly into the client .js files.
// ====================================================================================

/**
 * Normalize sequence to JSON string for injection
 */
function normalizeSequenceJS(seq) {
  if (Array.isArray(seq)) {
    return JSON.stringify(seq);
  }
  if (typeof seq === "string") {
    const items = seq
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number);
    return JSON.stringify(items);
  }
  return "[0, 1, 2, 3, 4]";
}

const MODULE_SEQUENCE_JS = normalizeSequenceJS(MODULE_SEQUENCE);
const CANVAS_SEQUENCE_JS = normalizeSequenceJS(CANVAS_SEQUENCE);

function updateSettings() {
  function buildHeaderBlock() {
    // This block is injected at the top of client files
    // NOTE: Sending renamed constants to the client to match new naming convention
    return (
      `const sampleRate = ${ANALYZER_SAMPLE_RATE};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXmode = "${MPX_MODE}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXStereoDecoder = "${MPX_STEREO_DECODER}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXInputCard = "${MPX_INPUT_CARD}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterInputCalibration = ${METER_INPUT_CALIBRATION_DB};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterPilotCalibration = ${METER_PILOT_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterMPXCalibration = ${METER_MPX_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterRDSCalibration = ${METER_RDS_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
      `const fftLibrary = "${FFT_LIBRARY}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const fftSize = ${FFT_SIZE};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumAttackLevel = ${SPECTRUM_ATTACK_LEVEL};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumDecayLevel = ${SPECTRUM_DECAY_LEVEL};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumSendInterval = ${SPECTRUM_SEND_INTERVAL};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumYOffset = ${SPECTRUM_Y_OFFSET};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumYDynamics = ${SPECTRUM_Y_DYNAMICS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const StereoBoost = ${STEREO_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
      `const AudioMeterBoost = ${AUDIO_METER_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
	  `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const CANVAS_SEQUENCE = ${CANVAS_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const LockVolumeSlider = ${LOCK_VOLUME_SLIDER};    // Do not touch - this value is automatically updated via the config file\n` +
      `const EnableSpectrumOnLoad = ${ENABLE_SPECTRUM_ON_LOAD};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterColorSafe = ${METER_COLOR_SAFE};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterColorWarning = ${METER_COLOR_WARNING};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MeterColorDanger = ${METER_COLOR_DANGER};    // Do not touch - this value is automatically updated via the config file\n` +
      `const PeakMode = "${PEAK_MODE}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const PeakColorFixed = "${PEAK_COLOR_FIXED}";    // Do not touch - this value is automatically updated via the config file\n` 
    );
  }

  function removeOldConstants(code) {
    // Regex to remove existing constant definitions to prevent duplicates
    let out = code
      // Old names
      .replace(/^\s*const\s+minSendIntervalMs\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+CurveYOffset\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+CurveYDynamics\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+Curve-Y-Offset\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+Curve-Y-Dynamics\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+stereoBoost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+eqBoost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+EqBoost\s*=.*;[^\n]*\n?/gm, "")

      // Renamed names
      .replace(/^\s*const\s+MPXinputCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXboost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXinputCalibrationDB\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+pilotCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+mpxCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+rdsCalibration\s*=.*;[^\n]*\n?/gm, "")

      // New names (to ensure clean update)
      .replace(/^\s*const\s+SpectrumSendInterval\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumYOffset\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumYDynamics\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+StereoBoost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+AudioMeterBoost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterInputCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterPilotCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterMPXCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterRDSCalibration\s*=.*;[^\n]*\n?/gm, "")

      // Other standard constants
      .replace(/^\s*const\s+MODULE_SEQUENCE\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+CANVAS_SEQUENCE\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+sampleRate\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+fftLibrary\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+fftSize\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumAverageLevel\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumAttackLevel\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumDecayLevel\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXmode\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+ExtStereoDecoder\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXStereoDecoder\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXInputCard\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+LockVolumeSlider\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+EnableSpectrumOnLoad\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterColorSafe\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterColorWarning\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MeterColorDanger\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+PeakMode\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+PeakColorFixed\s*=.*;[^\n]*\n?/gm, "");

    out = out.replace(
      /^\s*\/\/\s*Do not touch - this value is automatically updated via the config file\s*$/gm,
      ""
    );

    return out;
  }

  function insertAfterIIFE(code) {
    const cleaned = removeOldConstants(code);
    // Find the start of the Immediately Invoked Function Expression
    const iifePattern = /(\(\s*\)\s*=>\s*\{)[ \t]*\n?/;

    if (!iifePattern.test(cleaned)) {
      return cleaned;
    }

    return cleaned.replace(
      iifePattern,
      (_, prefix) => `${prefix}\n${buildHeaderBlock()}`
    );
  }

  // ====================================================================================
  //  CLIENT PATCH: METERS DEBUG LOGGING + MPX/RDS HANDLING
  // ====================================================================================
  function patchMetersClient(code) {
    let out = code;

    // 1) Inject debug helpers once (search marker: mm_meters_debug)
    if (!out.includes("mm_meters_debug")) {
      const debugBlock = `
    // ============================
    // DEBUG LOGGING (CLIENT)
    // Enable:
    //   localStorage.setItem("mm_meters_debug","1");   // throttled
    //   localStorage.setItem("mm_meters_debug","all"); // EVERY WS message
    // Disable:
    //   localStorage.removeItem("mm_meters_debug");
    // Also supported: URL param ?mmMetersDebug=1
    // ============================
    const MM_METERS_DEBUG_MODE =
      (localStorage.getItem("mm_meters_debug") ||
        (typeof location !== "undefined" && /(?:\\?|&)mmMetersDebug=1\\b/.test(location.search) ? "1" : ""));

    const MM_METERS_DEBUG_ALL = (MM_METERS_DEBUG_MODE === "all");
    const MM_METERS_DEBUG_ON  = !!MM_METERS_DEBUG_MODE;

    let _mmMetersLastLogMs = 0;

    function mmMetersLog(tag, data, throttleMs = 500) {
      if (!MM_METERS_DEBUG_ON) return;
      if (!MM_METERS_DEBUG_ALL) {
        const now = Date.now();
        if ((now - _mmMetersLastLogMs) < throttleMs) return;
        _mmMetersLastLogMs = now;
      }
      try { console.log("[MM Meters] " + tag, data); } catch {}
    }
`;
      const reVals = new RegExp(
        "(let\\s+valMpx\\s*=\\s*0;\\s*\\n\\s*let\\s+valPilot\\s*=\\s*0;\\s*\\n\\s*let\\s+valRds\\s*=\\s*0;\\s*\\n)"
      );
      out = out.replace(reVals, "$1" + debugBlock + "\n");
    }

    // 2) Fix early return that kills MPX/RDS updates
    const reEarlyReturn = new RegExp(
      "^\\s*//\\s*Ignore spectrum array[^\\n]*\\n\\s*if\\s*\\(\\s*Array\\.isArray\\(message\\.value\\)\\s*\\)\\s*\\{\\s*return;\\s*\\}\\s*\\n",
      "m"
    );
    out = out.replace(
      reEarlyReturn,
      "        // NOTE: The server always sends 'value' as spectrum array alongside peak/pilotKHz/rdsKHz.\n" +
      "        // Do NOT return here. Only ignore spectrum-only packets that lack 'peak'.\n" +
      "        if (typeof message.peak !== \"number\" && Array.isArray(message.value)) { return; }\n\n"
    );

    // 3) Add detailed logging to handleMpxMessage (log complete MPX payload + extracted values)
    const reHandleHead = new RegExp(
      "(function\\s+handleMpxMessage\\s*\\(message\\)\\s*\\{\\s*\\n\\s*if\\s*\\(!message\\s*\\|\\|\\s*typeof\\s+message\\s*!==\\s*[\"']object[\"']\\)\\s*return;\\s*\\n)"
    );
    out = out.replace(
      reHandleHead,
      "$1" +
      "        try {\n" +
      "          const safe = Object.assign({}, message);\n" +
      "          if (Array.isArray(safe.value)) {\n" +
      "            safe.valueLen = safe.value.length;\n" +
      "            safe.valuePreview = safe.value.slice(0, 12);\n" +
      "            delete safe.value;\n" +
      "          }\n" +
      "          mmMetersLog(\"RX MPX (full)\", safe, 0);\n" +
      "          mmMetersLog(\"RX MPX VALUES\", {\n" +
      "            peak: message.peak,\n" +
      "            pilotKHz: message.pilotKHz,\n" +
      "            rdsKHz: message.rdsKHz,\n" +
      "            pilotRaw: message.pilot,\n" +
      "            rdsRaw: message.rds,\n" +
      "            noise: message.noise,\n" +
      "            snr: message.snr\n" +
      "          }, 0);\n" +
      "        } catch {}\n"
    );

    // 4) Expand WS onmessage logging (RAW + PARSED)
    const reWsCore = new RegExp(
      "const\\s+msg\\s*=\\s*JSON\\.parse\\(event\\.data\\);\\s*\\n\\s*//\\s*Safety:\\s*Don't process bare arrays[^\\n]*\\n\\s*if\\s*\\(Array\\.isArray\\(msg\\)\\)\\s*return;\\s*\\n\\s*\\n\\s*if\\s*\\(msg\\.type\\s*===\\s*[\"']MPX[\"']\\)\\s*handleMpxMessage\\(msg\\);",
      "m"
    );
    out = out.replace(
      reWsCore,
      "mmMetersLog(\"WS RAW\", event.data, 0);\n" +
      "          const msg = JSON.parse(event.data);\n" +
      "          if (Array.isArray(msg)) {\n" +
      "            mmMetersLog(\"WS PARSED (array)\", { len: msg.length, preview: msg.slice(0, 12) }, 0);\n" +
      "            return;\n" +
      "          }\n" +
      "          try {\n" +
      "            const safe = Object.assign({}, msg);\n" +
      "            if (Array.isArray(safe.value)) {\n" +
      "              safe.valueLen = safe.value.length;\n" +
      "              safe.valuePreview = safe.value.slice(0, 12);\n" +
      "              delete safe.value;\n" +
      "            }\n" +
      "            mmMetersLog(\"WS PARSED (object)\", safe, 0);\n" +
      "          } catch {}\n" +
      "          if (msg.type === \"MPX\") handleMpxMessage(msg);"
    );

    return out;
  }

  function updateClientFile(filePath, label, modifyFn) {
    try {
      const data = fs.readFileSync(filePath, "utf8");
      const updated = modifyFn(data);
      fs.writeFileSync(filePath, updated, "utf8");
    } catch (err) {
      logError(`[MPX] Error updating ${label}:`, err);
    }
  }

  // Update specific files
  updateClientFile(MetricsMonitorClientFile, "metricsmonitor.js", (code) => {
    let updated = code;
    const moduleSeqRegex = /^\s*const\s+MODULE_SEQUENCE\s*=.*;[^\n]*$/m;

    if (moduleSeqRegex.test(updated)) {
      updated = updated.replace(
        moduleSeqRegex,
        `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file`
      );
    } else {
      updated =
        `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
        updated;
    }
    return insertAfterIIFE(updated);
  });

  updateClientFile(
    MetricsMonitorClientAnalyzerFile,
    "metricsmonitor-analyzer.js",
    insertAfterIIFE
  );
  updateClientFile(
    MetricsMonitorClientAudioMeterFile,
    "metricsmonitor-audiometer.js",
    insertAfterIIFE
  );
  updateClientFile(
    MetricsMonitorClientHeaderFile,
    "metricsmonitor-header.js",
    insertAfterIIFE
  );
  updateClientFile(
    MetricsMonitorClientMetersFile,
    "metricsmonitor-meters.js",
    (code) => patchMetersClient(insertAfterIIFE(code))
  );
  updateClientFile(
    MetricsMonitorClientSignalMeterFile,
    "metricsmonitor-signalmeter.js",
    insertAfterIIFE
  );
  updateClientFile(
    MetricsMonitorClientSignalAnalyzerFile,
    "metricsmonitor-signal-analyzer.js",
    insertAfterIIFE
  );
}

/**
 * DEPLOY CLIENT FILES
 * Copies the client-side files from the plugin directory to the Webserver's public `web` folder.
 */
function copyClientFiles() {
  if (process.platform === "win32") {
    logInfo("[MPX] Windows detected – skipping client file copy.");
    return;
  }

  const srcDir = __dirname;
  const destDir = path.join(__dirname, "../../web/js/plugins/MetricsMonitor");

  logInfo("[MPX] Updating client files in:", destDir);

  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.chmodSync(destDir, 0o775);
  } catch (e) {
    logError("[MPX] Failed to create destination directory:", e);
    return;
  }

  const folders = ["css", "js", "images"];

  folders.forEach((folder) => {
    const folderSrc = path.join(srcDir, folder);
    const folderDest = path.join(destDir, folder);

    if (!fs.existsSync(folderSrc)) return;

    fs.mkdirSync(folderDest, { recursive: true });
    try {
      fs.chmodSync(folderDest, 0o775);
    } catch {}

    const items = fs.readdirSync(folderSrc);
    items.forEach((item) => {
      const s = path.join(folderSrc, item);
      const d = path.join(folderDest, item);
      try {
        fs.copyFileSync(s, d);
        fs.chmodSync(d, 0o664);
        logInfo(`[MPX] Copied client file: ${d}`);
      } catch (err) {
        logError("[MPX] Error copying client file:", err);
      }
    });
  });

  const singleFiles = ["metricsmonitor.js"];
  singleFiles.forEach((file) => {
    const s = path.join(srcDir, file);
    const d = path.join(destDir, file);
    if (!fs.existsSync(s)) return;
    try {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, 0o664);
      logInfo(`[MPX] Copied client root file: ${file}`);
    } catch (err) {
      logError("[MPX] Failed to copy client root file", file, err);
    }
  });
}

// Run update routines immediately
updateSettings();
copyClientFiles();

// ====================================================================================
//  MAIN SERVER LOGIC START
//  This is where the actual signal processing loop begins.
// ====================================================================================

if (!ENABLE_MPX) {
  logInfo(
    `[MPX] MODULE_SEQUENCE = ${MODULE_SEQUENCE} → ` +
    "MPX capture & server-side MPX processing are disabled."
  );
} else {
  // If enabled, proceed to setup
  ensureRequiredModules();

  let FFT = null;
  let pffftModule = null;
  let pffftSetup = null;
  let pffftInputPtr = null;
  let pffftOutputPtr = null;
  let pffftWorkPtr = null;
  let pffftInputHeap = null;
  let pffftOutputHeap = null;
  let fftReady = false;

  // Initialize FFT Library (WASM or JS fallback)
  if (FFT_LIBRARY === "pffft.wasm") {
    logInfo("[MPX] Initializing pffft.wasm library...");
    (async () => {
      try {
        const PFFFT = await import("@echogarden/pffft-wasm");
        pffftModule = await PFFFT.default();

        pffftSetup = pffftModule._pffft_new_setup(FFT_SIZE, 0);
        pffftInputPtr = pffftModule._pffft_aligned_malloc(FFT_SIZE * 4);
        pffftOutputPtr = pffftModule._pffft_aligned_malloc(FFT_SIZE * 4);
        pffftWorkPtr = pffftModule._pffft_aligned_malloc(FFT_SIZE * 4);

        pffftInputHeap = new Float32Array(
          pffftModule.HEAPF32.buffer,
          pffftInputPtr,
          FFT_SIZE
        );
        pffftOutputHeap = new Float32Array(
          pffftModule.HEAPF32.buffer,
          pffftOutputPtr,
          FFT_SIZE
        );

        fftReady = true;
        logInfo(
          `[MPX] pffft.wasm initialized successfully for FFT size ${FFT_SIZE}`
        );
      } catch (e) {
        logError("[MPX] Failed to initialize pffft.wasm:", e);
        FFT = require("fft-js").fft;
        fftReady = true;
        logInfo("[MPX] Fallback to 'fft-js' active.");
      }
    })();
  } else {
    FFT = require("fft-js").fft;
    fftReady = true;
    logInfo("[MPX] Using standard 'fft-js' library.");
  }

  // Apply patches
  patch3LAS();
  patchHelpersForLocalhostBypass();

  let SAMPLE_RATE = CONFIG_SAMPLE_RATE;
  const HOP_SIZE = FFT_SIZE / 2;
  const MAX_LATENCY_BLOCKS = 2;

  let SERVER_PORT = 8080;
  try {
    if (mainConfig?.webserver?.webserverPort) {
      SERVER_PORT = parseInt(mainConfig.webserver.webserverPort, 10);
      if (isNaN(SERVER_PORT)) SERVER_PORT = 8080;
    }
  } catch (e) {
    SERVER_PORT = 8080;
  }

  logInfo(`[MPX] Using webserver port from config.json → ${SERVER_PORT}`);
  logInfo(
    `[MPX] sampleRate from metricsmonitor.json → ${CONFIG_SAMPLE_RATE} Hz`
  );
  logInfo(`[MPX] FFT Library → ${FFT_LIBRARY}`);
  logInfo(`[MPX] FFT_SIZE from metricsmonitor.json → ${FFT_SIZE} points`);
  logInfo(`[MPX] Analyzer enabled? → ${ENABLE_ANALYZER}`);
  logInfo(
    `[MPX] SpectrumSendInterval from metricsmonitor.json → ${SPECTRUM_SEND_INTERVAL} ms`
  );
  logInfo(`[MPX] MPXmode from metricsmonitor.json → ${MPX_MODE}`);
  logInfo(
    `[MPX] MPXStereoDecoder from metricsmonitor.json → ${MPX_STEREO_DECODER}`
  );
  
  // Separate Calibration Logs
  logInfo(`[MPX] MeterInputCalibration (Meters) → ${METER_INPUT_CALIBRATION_DB} dB (Factor: ${METER_GAIN_FACTOR.toFixed(3)})`);
  logInfo(`[MPX] SpectrumInputCalibration (Spectrum) → ${SPECTRUM_INPUT_CALIBRATION_DB} dB (Factor: ${SPECTRUM_GAIN_FACTOR.toFixed(3)})`);

  if (MPX_INPUT_CARD !== "") {
    logInfo(`[MPX] MPXInputCard from metricsmonitor.json → "${MPX_INPUT_CARD}"`);
  }

  // ====================================================================================
  //  BINARY SELECTION LOGIC
  //  Selects the correct MPXCapture binary based on OS/Arch.
  // ====================================================================================
  const osPlatform = process.platform;
  const osArch = process.arch;

  let runtimeFolder = null;
  let binaryName = null;

  if (osPlatform === "win32") {
    const archEnv = process.env.PROCESSOR_ARCHITECTURE || "";
    const archWow = process.env.PROCESSOR_ARCHITEW6432 || "";
    const is64BitOS =
      archEnv.toUpperCase() === "AMD64" || archWow.toUpperCase() === "AMD64";

    runtimeFolder = is64BitOS ? "win-x64" : "win-x86";
    binaryName = "MPXCapture.exe";
  } else if (osPlatform === "linux") {
    if (osArch === "arm" || osArch === "armhf") {
      runtimeFolder = "linux-arm";
    } else if (osArch === "arm64") {
      runtimeFolder = "linux-arm64";
    } else {
      runtimeFolder = "linux-x64";
    }
    binaryName = "MPXCapture";
  } else if (osPlatform === "darwin") {
    runtimeFolder = osArch === "arm64" ? "osx-arm64" : "osx-x64";
    binaryName = "MPXCapture";
  } else {
    logError(
      `[MPX] Unsupported platform ${osPlatform}/${osArch} – MPXCapture will not be started.`
    );
  }

  let MPX_EXE_PATH = null;

  if (!runtimeFolder || !binaryName) {
    logWarn(
      "[MPX] No runtimeFolder/binaryName detected – MPXCapture disabled."
    );
  } else if (
    osPlatform === "win32" &&
    CONFIG_SAMPLE_RATE === 48000 &&
    MPX_INPUT_CARD === ""
  ) {
    logWarn(
      "[MPX] CONFIG_SAMPLE_RATE = 48000 on Windows (and no MPXInputCard) → using 3LAS, MPXCapture disabled."
    );
  } else {
    MPX_EXE_PATH = path.join(__dirname, "bin", runtimeFolder, binaryName);
    MPX_EXE_PATH = MPX_EXE_PATH.replace(/^['\"]+|['\"]+$/g, "");
    logInfo(
      `[MPX] Using MPXCapture binary for ${osPlatform}/${osArch} → ${runtimeFolder}/${binaryName}`
    );
  }

  const BIN_STEP = 2;
  const MAX_WS_BACKLOG_BYTES = 256 * 1024;

  logInfo(
    "[MPX] MPX server started (Fast & Smooth v2.1, Peak/Pilot/RDS Time Domain)."
  );

  // ====================================================================================
  //  WEBSOCKET SERVER
  //  Handles data distribution to clients.
  // ====================================================================================
  let dataPluginsWs = null;
  let reconnectTimer = null;
  const MAX_BACKPRESSURE_HITS = 200;

  function connectDataPluginsWs() {
    const url = `ws://127.0.0.1:${SERVER_PORT}/data_plugins`;

    if (
      dataPluginsWs &&
      (dataPluginsWs.readyState === WebSocket.OPEN ||
        dataPluginsWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    logInfo("[MPX] Connecting to /data_plugins:", url);

    dataPluginsWs = new WebSocket(url);
    backpressureHits = 0;

    dataPluginsWs.on("open", () => {
      logInfo("[MPX] Connected to /data_plugins WebSocket.");
      backpressureHits = 0;
    });

    dataPluginsWs.on("close", () => {
      logInfo("[MPX] /data_plugins WebSocket closed – retrying in 5 seconds.");
      dataPluginsWs = null;

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectDataPluginsWs();
        }, 5000);
      }
    });

    dataPluginsWs.on("error", (err) => {
      logError("[MPX] /data_plugins WebSocket error:", err);
    });

    dataPluginsWs.on("message", () => {});
  }

  connectDataPluginsWs();

  // ====================================================================================
  //  SIGNAL PROCESSING BUFFERS & VARIABLES
  // ====================================================================================
  let use3LasPcmFormat = false;
  let sampleBuffer = [];

  // HYBRID WINDOWING CONFIGURATION
  // Precision for Pilot/RDS (Frequency stability)
  // Fast for Audio (Broadband energy, low CPU usage)
  const WIN_PRECISION = 4096; 
  const WIN_FAST = 256;       

  // Accumulator must be large enough for the biggest window
  const GOERTZEL_WINDOW_SIZE = WIN_PRECISION; 
  
  let goertzelAccumulator = [];
  
  // Storage for pre-calculated Hann windows
  let goertzelWindowPrecision = null;
  let goertzelWindowFast = null;
  
  let currentMaxPeak = 0;
  let currentPilotPeak = 0;
  let currentRdsPeak = 0;
  let currentNoiseFloor = 0;
  
  let currentMonoPeak = 0;
  let currentStereoPeak = 0;

  let fftBlock = null;
  let windowHann = null;

  if (ENABLE_ANALYZER) {
    fftBlock = new Float32Array(FFT_SIZE);
    windowHann = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      windowHann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    }
  }

  let latestMpxFrame = null;

  /**
   * Initialize BOTH Hann Windows (Precision & Fast)
   */
  function initGoertzelWindow() {
    // 1. Precision Window (2048)
    goertzelWindowPrecision = new Float32Array(WIN_PRECISION);
    for (let i = 0; i < WIN_PRECISION; i++) {
      goertzelWindowPrecision[i] =
        0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN_PRECISION - 1)));
    }

    // 2. Fast Window (256)
    goertzelWindowFast = new Float32Array(WIN_FAST);
    for (let i = 0; i < WIN_FAST; i++) {
      goertzelWindowFast[i] =
        0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN_FAST - 1)));
    }

    logInfo(
      `[MPX] Hybrid Analyzer initialized. Precision: ${WIN_PRECISION}, Fast: ${WIN_FAST}`
    );
  }

  // ====================================================================================
  //  GOERTZEL ALGORITHM (OPTIMIZED)
  //  Now accepts a specific window array to support hybrid processing.
  // ====================================================================================
  function calculateGoertzelWindowed(samples, targetFreq, sampleRate, windowArray) {
    if (sampleRate < 1000) return 0;
    
    // Safety check: sample length must match window length
    const len = samples.length;
    if (len !== windowArray.length) return 0;

    const omega = (2.0 * Math.PI * targetFreq) / sampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const coeff = 2.0 * cosine;

    let q0 = 0, q1 = 0, q2 = 0;

    for (let i = 0; i < len; i++) {
      const windowedSample = samples[i] * windowArray[i];
      q0 = coeff * q1 - q2 + windowedSample;
      q2 = q1;
      q1 = q0;
    }

    const real = q1 - q2 * cosine;
    const imag = q2 * sine;

    return (Math.sqrt(real * real + imag * imag) * 2.0) / len * 2.0;
  }
   
  // ====================================================================================
  //  AUDIO INPUT INITIALIZATION
  //  Selects between 3LAS stream or MPXCapture binary.
  // ====================================================================================
  let rec = null;
  const explicitCard =
    MPX_INPUT_CARD !== "" && MPX_INPUT_CARD.toLowerCase() !== "off";

  const USE_3LAS = !explicitCard && CONFIG_SAMPLE_RATE === 48000;

  if (USE_3LAS) {
    try {
      const audioStream = require("./../../server/stream/3las.server");

      if (!audioStream || !audioStream.waitUntilReady) {
        logWarn(
          "[MPX] 3LAS server not available – MPX spectrum capture disabled."
        );
      } else {
        audioStream.waitUntilReady
          .then(() => {
            const s = audioStream.Server;
            if (!s || !s.StdIn) {
              logError(
                "[MPX] 3LAS Server has no StdIn stream – MPX spectrum capture disabled."
              );
              return;
            }

            if (typeof s.SampleRate === "number" && s.SampleRate > 0) {
              SAMPLE_RATE = s.SampleRate;
            } else {
              SAMPLE_RATE = CONFIG_SAMPLE_RATE || 48000;
              logWarn(
                `[MPX] 3LAS sampleRate unknown – assuming ${SAMPLE_RATE} Hz for MPX spectrum.`
              );
            }

            use3LasPcmFormat = true;

            logInfo(
              `[MPX] Subscribing to 3LAS StdIn PCM stream (${osPlatform}) @ ${SAMPLE_RATE} Hz`
            );

            s.StdIn.on("data", (buffer) => {
              handlePcmChunk(buffer);
            });
          })
          .catch((err) => {
            logError("[MPX] Error while waiting for 3LAS audio stream:", err);
          });
      }
    } catch (e) {
      logError(
        "[MPX] Failed to require 3las.server – MPX spectrum capture disabled:",
        e
      );
    }
  } else if (!MPX_EXE_PATH) {
    logWarn(
      "[MPX] MPXCapture path not resolved or platform unsupported – not starting MPXCapture."
    );
  } else if (!fs.existsSync(MPX_EXE_PATH)) {
    logError("[MPX] MPXCapture binary not found at path:", MPX_EXE_PATH);
  } else {
    use3LasPcmFormat = false;

    if (osPlatform !== "win32") {
      try {
        fs.chmodSync(MPX_EXE_PATH, 0o755);
      } catch (err) {
        logWarn(
          `[MPX] Failed to set execution permissions for ${MPX_EXE_PATH}:`,
          err
        );
      }
    }

    const args = [String(SAMPLE_RATE)];

    if (explicitCard) {
      logInfo(
        `[MPX] Starting MPXCapture with specific device: "${MPX_INPUT_CARD}"`
      );
      args.push(MPX_INPUT_CARD);
    } else {
      logInfo(
        `[MPX] Starting MPXCapture (${osPlatform}/${osArch}) with SAMPLE_RATE = ${SAMPLE_RATE} Hz (Default Device)`
      );
    }

    rec = spawn(MPX_EXE_PATH, args);

    rec.stderr.on("data", (d) => {
      const text = d.toString().trim();
      if (text.length > 0) {
        logInfo("[MPX-EXE]", text);
      }
    });

    rec.stdout.on("data", handlePcmChunk);

    rec.on("close", (code, signal) => {
      logInfo(
        "[MPX] MPXCapture exited with code:",
        code,
        "signal:",
        signal || "none"
      );
      if (explicitCard && code !== 0) {
        logWarn(
          `[MPX] MPXCapture exited prematurely. Verify if device "${MPX_INPUT_CARD}" exists and is not in use.`
        );
      }
    });
  }

  // ====================================================================================
  //  PCM Sampling
  // ====================================================================================
  
  // We store the last measurement values to bridge gaps in modulation.
  let rdsHistoryBuffer = [];
  const RDS_HISTORY_SIZE = 40; // Approx. 1-2 seconds of history at typical chunk rates

  // Frequencies: Focus on the energetic sidebands (55.5 - 58.5)
  const RDS_SCAN_FREQUENCIES = [
      55800, 55850, 55900, 55950, 56000, 56050, 56100, 56150, 56200, 57800, 57850, 57900, 57950, 58000, 58050, 58100, 58150, 58200
  ];

  function handlePcmChunk(chunk) {
    if (!chunk.length) return;
    
    const processingRate = (SAMPLE_RATE && SAMPLE_RATE > 0) ? SAMPLE_RATE : 48000;
    if (ENABLE_GOERTZEL && !goertzelWindowPrecision) initGoertzelWindow();

    let meterBuffer = []; 

    // --- 1. DECODE PCM DATA ---
    if (use3LasPcmFormat) {
        const intData = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        for (let i = 0; i < intData.length; i += 2) {
            const v = ((intData[i]/32768.0) + ((intData[i+1]??intData[i])/32768.0))*0.5;
            if (ENABLE_FFT) sampleBuffer.push(v * SPECTRUM_GAIN_FACTOR);
            if (ENABLE_GOERTZEL) meterBuffer.push(v * METER_GAIN_FACTOR);
        }
    } else {
        const floatData = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
        for (let i = 0; i < floatData.length; i += 2) {
            const v = (floatData[i] + (floatData[i+1]??floatData[i]))*0.5;
            if (ENABLE_FFT) sampleBuffer.push(v * SPECTRUM_GAIN_FACTOR);
            if (ENABLE_GOERTZEL) meterBuffer.push(v * METER_GAIN_FACTOR);
        }
    }

    // --- 2. METER LOGIC ---
    if (ENABLE_GOERTZEL) {
        let chunkMax = 0;
        for (let i = 0; i < meterBuffer.length; i++) {
          let val = Math.abs(meterBuffer[i]);
          if (val > chunkMax) chunkMax = val;
          if (goertzelWindowPrecision) goertzelAccumulator.push(meterBuffer[i]);
        }
        
        if (chunkMax >= currentMaxPeak) currentMaxPeak = chunkMax;
        else currentMaxPeak = currentMaxPeak * 0.95 + chunkMax * 0.05;

        if (goertzelAccumulator.length > WIN_PRECISION * 4) goertzelAccumulator = goertzelAccumulator.slice(-WIN_PRECISION);

        while (goertzelAccumulator.length >= WIN_PRECISION) {
            const chunkBig = goertzelAccumulator.slice(0, WIN_PRECISION);
            const chunkFast = chunkBig.slice(WIN_PRECISION - WIN_FAST);
            goertzelAccumulator = goertzelAccumulator.slice(Math.floor(WIN_PRECISION * 0.5));
            
            const pilot = calculateGoertzelWindowed(chunkBig, 19000, processingRate, goertzelWindowPrecision);
            
            // --- RDS STABILITY LOGIC ---
            // 1. Find the strongest point in the spectrum for this moment
            let momentMaxRds = 0;
            for (let f of RDS_SCAN_FREQUENCIES) {
                let amp = calculateGoertzelWindowed(chunkBig, f, processingRate, goertzelWindowPrecision);
                if (amp > momentMaxRds) momentMaxRds = amp;
            }
            
            // 2. Push into history buffer
            rdsHistoryBuffer.push(momentMaxRds);
            if (rdsHistoryBuffer.length > RDS_HISTORY_SIZE) rdsHistoryBuffer.shift();
            
            // 3. Calculate robust value from history
            // We sort the history and take the median of the upper half.
            // This ignores "zeros" (modulation gaps) and "spikes" (interference).
            let sortedHistory = [...rdsHistoryBuffer].sort((a, b) => b - a);
            // Take the value at index 5 (from the top). This is a stable "high" value, but not a single outlier.
            let stableIndex = Math.floor(sortedHistory.length * 0.2); // Top 20% Percentile
            if (stableIndex >= sortedHistory.length) stableIndex = 0;
            let stableRds = sortedHistory[stableIndex] || 0;

            const n1 = calculateGoertzelWindowed(chunkBig, 17000, processingRate, goertzelWindowPrecision); 
            const n2 = calculateGoertzelWindowed(chunkBig, 21000, processingRate, goertzelWindowPrecision); 
            const avgNoise = (n1 + n2) / 2.0;
            
            // Mono / Stereo (simplified for performance)
            let maxMono = 0;
            for(let f=100; f<=15000; f+=2000) maxMono += calculateGoertzelWindowed(chunkFast, f, processingRate, goertzelWindowFast);
            maxMono /= 8;

            let maxStereo = 0;
            for(let f=24000; f<=52000; f+=4000) maxStereo += calculateGoertzelWindowed(chunkFast, f, processingRate, goertzelWindowFast);
            maxStereo /= 8;

            currentNoiseFloor = currentNoiseFloor * 0.90 + avgNoise * 0.10;
            currentPilotPeak = currentPilotPeak * 0.85 + pilot * 0.15;
            
            // Here we pass the STABILIZED value from the buffer
            currentRdsPeak = currentRdsPeak * 0.8 + stableRds * 0.2;
            
            currentMonoPeak = currentMonoPeak * 0.5 + maxMono * 0.5;
            currentStereoPeak = currentStereoPeak * 0.5 + maxStereo * 0.5;
        }
    }

    // --- 3. FFT ---
    if (ENABLE_FFT && fftReady && sampleBuffer.length >= FFT_SIZE) {
        if (sampleBuffer.length > MAX_LATENCY_BLOCKS * FFT_SIZE) sampleBuffer.splice(0, sampleBuffer.length - MAX_LATENCY_BLOCKS * FFT_SIZE);
        const start = sampleBuffer.length - FFT_SIZE;
        for(let i=0; i<FFT_SIZE; i++) fftBlock[i] = sampleBuffer[start+i] * windowHann[i];
        
        // FFT Fallback Safety (same as before)
        if (typeof FFT !== 'function' && !pffftModule) {
             try { const _fftLib = require("fft-js"); FFT = _fftLib.fft || _fftLib; } catch(e) { return; }
        }

        if (pffftModule || typeof FFT === 'function') {
             // ... FFT calculation code (same as before) ...
             let mags = new Float32Array(FFT_SIZE/2);
             if (pffftModule) {
                pffftInputHeap.set(fftBlock);
                pffftModule._pffft_transform_ordered(pffftSetup, pffftInputPtr, pffftOutputPtr, pffftWorkPtr, 0);
                for(let i=0; i<FFT_SIZE/2; i++) {
                    const re = pffftOutputHeap[2*i], im = pffftOutputHeap[2*i+1];
                    mags[i] = (Math.sqrt(re*re + im*im)/(FFT_SIZE/2)) * (i>0?10:1);
                }
             } else {
                 try {
                    const phasors = FFT(fftBlock);
                    for(let i=0; i<FFT_SIZE/2; i++) mags[i] = (Math.sqrt(phasors[i][0]**2 + phasors[i][1]**2)/(FFT_SIZE/2)) * (i>0?10:1);
                 } catch(e) {}
             }
             
             const mpx = [];
             for (let i = 0; i < FFT_SIZE/2; i+=2) {
                if ((i*processingRate/FFT_SIZE) > 100000) break;
                mpx.push(Math.round(mags[i]*100000)/100000);
             }
             if (mpx.length) latestMpxFrame = mpx;
        }
        
        const keep = Math.max(0, sampleBuffer.length - HOP_SIZE);
        if (keep > 0) sampleBuffer.splice(0, keep); else sampleBuffer.length = 0;
    }
  }

  // ====================================================================================
  //  MAIN BROADCAST LOOP
  // ====================================================================================

  const PILOT_SCALE_KHZ_PER_AMP = 1100.0;
  const RDS_SCALE_KHZ_PER_AMP = 8000.0; 
  const MPX_SCALE_KHZ_PER_AMP = 148.0;      
  const MONO_SCALE_KHZ_PER_AMP = 7000.0;     
  const STEREO_SCALE_KHZ_PER_AMP = 4000.0;  

  let out_mpx = 0, out_pilot = 0, out_rds = 0;

  if (typeof global.mpxPeakState === 'undefined') global.mpxPeakState = 0;
  if (typeof global.pilotFastAvg === 'undefined') global.pilotFastAvg = 0;
  if (typeof global.rdsStableValue === 'undefined') global.rdsStableValue = 0;
  if (typeof global.mpxDisplayPeak === 'undefined') global.mpxDisplayPeak = 0;
  if (typeof global.logThrottle === 'undefined') global.logThrottle = 0;
  if (typeof global.monoDevSmoother === 'undefined') global.monoDevSmoother = 0;
  if (typeof global.stereoIntegrator === 'undefined') global.stereoIntegrator = 0;
  if (typeof global.lastStableMode === 'undefined') global.lastStableMode = false;

  setInterval(() => {
    if (!dataPluginsWs || dataPluginsWs.readyState !== WebSocket.OPEN) return;
    if (dataPluginsWs.bufferedAmount > 262144) { if (++backpressureHits >= 50) { try { dataPluginsWs.terminate(); } catch {} dataPluginsWs = null; } return; }
    backpressureHits = 0;

    let rP = 0, rR = 0, rM = 0, rN = 0.000001, rMono = 0, rStereo = 0;
    
    if (ENABLE_GOERTZEL) {
        rP = currentPilotPeak;
        rR = currentRdsPeak; 
        rM = currentMaxPeak;
        rN = currentNoiseFloor || 0.000001;
        rMono = currentMonoPeak;
        rStereo = currentStereoPeak;
    }

    // --- 1. PILOT ---
    let cleanPilot = rP - (rN * 1.5); if (cleanPilot < 0) cleanPilot = 0;
    global.pilotFastAvg = (global.pilotFastAvg * 0.9) + (cleanPilot * 0.1);
    let rawPilotKHz = global.pilotFastAvg * PILOT_SCALE_KHZ_PER_AMP;
    if (rawPilotKHz > 0.5) out_pilot = rawPilotKHz + METER_PILOT_CALIBRATION; else out_pilot = rawPilotKHz; 
    if (out_pilot < 0) out_pilot = 0;

    // --- 2. RDS (STABILIZED) ---
    // Since we have the stable value from the buffer, we hardly need noise subtraction anymore.
    let cleanRds = rR - (rN * 0.8); 
    if (cleanRds < 0) cleanRds = 0;
    
    let rawRdsKHz = cleanRds * RDS_SCALE_KHZ_PER_AMP;

    // Calibration Offset
    if (rawRdsKHz > 0.5) rawRdsKHz += METER_RDS_CALIBRATION;
    
    // Limits
    if (rawRdsKHz < 0.2) rawRdsKHz = 0; 
    if (rawRdsKHz > 12.0) rawRdsKHz = 12.0; 
    
    // Smoothing: A normal low-pass is sufficient here, as the buffer has already removed wild jumps.
    let sm = (rawRdsKHz > 0) ? 0.02 : 0.05;
    global.rdsStableValue = (global.rdsStableValue * (1-sm)) + (rawRdsKHz * sm);
    out_rds = global.rdsStableValue;

    // --- 3. REST (MONO/STEREO/MPX) ---
    let cleanMono = rMono - (rN * 4.0); if (cleanMono < 0) cleanMono = 0;
    let rawMonoDev = cleanMono * MONO_SCALE_KHZ_PER_AMP;
    let monoAttack = (rawMonoDev > global.monoDevSmoother) ? 0.15 : 0.10;
    global.monoDevSmoother = (global.monoDevSmoother * (1 - monoAttack)) + (rawMonoDev * monoAttack);
    let out_mono_dev = global.monoDevSmoother;

    let cleanStereo = rStereo - (rN * 2.5); if (cleanStereo < 0) cleanStereo = 0;
    let out_stereo_dev = cleanStereo * STEREO_SCALE_KHZ_PER_AMP;

    let instantStereo = (out_pilot > 2.0); 

    if (instantStereo) {
        global.stereoIntegrator++;
        if (global.stereoIntegrator > 20) global.stereoIntegrator = 20;
    } else {
        global.stereoIntegrator--;
        if (global.stereoIntegrator < 0) global.stereoIntegrator = 0;
    }
    
    let isStereoStable = (global.stereoIntegrator > 10);
    if (!isStereoStable && global.stereoIntegrator < 2) global.lastStableMode = false;
    else if (isStereoStable) global.lastStableMode = true;
    isStereoStable = global.lastStableMode;
    global.isStereoLocked = isStereoStable;
    
    let calcMpx = 0;
    if (!isStereoStable) {
        calcMpx = out_mono_dev + out_pilot + out_rds;
        if (calcMpx > 1.0) calcMpx = calcMpx * 1.05;
    } else {
        let cleanPeak = rM - (rN * 1.5);
        if (cleanPeak < 0) cleanPeak = 0;
        let tdMpx = cleanPeak * MPX_SCALE_KHZ_PER_AMP;
        if (tdMpx > 5.0) tdMpx += METER_MPX_CALIBRATION + 50;
        if (tdMpx < out_mono_dev) tdMpx = (tdMpx * 0.5) + (out_mono_dev * 0.5);
        calcMpx = tdMpx;
    }

    let target = calcMpx;
    if (target > global.mpxPeakState) global.mpxPeakState = (global.mpxPeakState * 0.85) + (target * 0.15);
    else global.mpxPeakState = (global.mpxPeakState * 0.98) + (target * 0.02);
    let finalMpx = global.mpxPeakState;
    let floor = out_pilot + out_rds;
    if (finalMpx < floor && finalMpx > 0.5) finalMpx = floor;
    if (out_pilot < 1.0 && out_rds < 1.0) finalMpx = 0;
    if (finalMpx > 150.0) finalMpx = 150.0;
    if (finalMpx >= global.mpxDisplayPeak) global.mpxDisplayPeak = finalMpx;
    else global.mpxDisplayPeak = (global.mpxDisplayPeak * 0.98) + (finalMpx * 0.02);
    out_mpx = global.mpxDisplayPeak;

    if (ENABLE_EXTENDED_LOGGING) {
        global.logThrottle++;
        if (global.logThrottle >= 33) { 
             global.logThrottle = 0;
             let modeStr = isStereoStable ? "STEREO" : "MONO";
             let sumCheck = out_mono_dev + out_stereo_dev + out_pilot + out_rds;
             logInfo(`[MPX] Mode:${modeStr} | Mono:${out_mono_dev.toFixed(1)}k | Pilot:${out_pilot.toFixed(1)}k | Stereo:${out_stereo_dev.toFixed(1)}k | RDS:${out_rds.toFixed(1)}k | SUM_PARTS:${sumCheck.toFixed(1)}k -> MPX:${out_mpx.toFixed(1)} kHz`);
        }
    }

    const payload = JSON.stringify({
      type: "MPX", value: latestMpxFrame||[], peak: out_mpx, pilotKHz: out_pilot, rdsKHz: out_rds,
      pilot: rP, rds: rR, noise: rN, snr: (rN > 0.000001) ? (rP / rN) : 0
    });
    
    currentMaxPeak = 0; 
    dataPluginsWs.send(payload, ()=>{});
    
  }, SPECTRUM_SEND_INTERVAL);
  
  // Cleanup Handlers
  if (FFT_LIBRARY === "pffft.wasm") {
    process.on("exit", () => {
      if (pffftModule && pffftSetup) {
        try {
          pffftModule._pffft_destroy_setup(pffftSetup);
          pffftModule._pffft_aligned_free(pffftInputPtr);
          pffftModule._pffft_aligned_free(pffftOutputPtr);
          pffftModule._pffft_aligned_free(pffftWorkPtr);
        } catch (e) {}
      }
    });
  }
}