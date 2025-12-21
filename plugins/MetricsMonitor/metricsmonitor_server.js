///////////////////////////////////////////////////////////////
//                                                           //
//  METRICSMONITOR SERVER SCRIPT FOR FM-DX-WEBSERVER  (V1.4) //
//                                                           //
//  by Highpoint               last update: 20.12.2025       //
//                                                           //
//  Thanks for support by                                    //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude      //
//                                                           //
//  https://github.com/Highpoint2000/metricsmonitor          //
//                                                           //
///////////////////////////////////////////////////////////////

// ============================================================
//  DEBUG CONFIGURATION
//  Set to 'true' to enable detailed logging of MPX/RDS/SNR values
//  to the console for troubleshooting.
// ============================================================
const ENABLE_EXTENDED_LOGGING = false;

const { spawn, execSync } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { logInfo, logError, logWarn } = require("./../../server/console");
const mainConfig = require("./../../config.json");

//-------------------------------------------------------------
//  Plugin Configuration Path
//-------------------------------------------------------------
const configFilePath = path.join(
  __dirname,
  "./../../plugins_configs/metricsmonitor.json"
);

//-------------------------------------------------------------
//  Default Configuration Object
//-------------------------------------------------------------
const defaultConfig = {
  sampleRate: 48000,
  MPXboost: 0,
  MPXmode: "off",
  MPXStereoDecoder: "off",
  MPXInputCard: "",
  fftLibrary: "fft-js",
  fftSize: 1024,
  SpectrumAttackLevel: 3,
  SpectrumDecayLevel: 15,
  minSendIntervalMs: 30,
  pilotCalibration: 0.0,
  mpxCalibration: 0.0,
  rdsCalibration: 0.0,
  "Curve-Y-Offset": -40,
  "Curve-Y-Dynamics": 1.9,
  stereoBoost: 1.0,
  eqBoost: 1.0,
  MODULE_SEQUENCE: "1,2,0,3,4",
  CANVAS_SEQUENCE: "4,2",
  LockVolumeSlider: true,
  EnableSpectrumOnLoad: false,
};

//-------------------------------------------------------------
//  Config Normalization Logic
//  Ensures the configuration object has all required fields,
//  migrating old keys if necessary.
//-------------------------------------------------------------
function normalizePluginConfig(json) {
  // Migrate deprecated "ExtStereoDecoder" to "MPXStereoDecoder"
  if (
    typeof json.ExtStereoDecoder !== "undefined" &&
    typeof json.MPXStereoDecoder === "undefined"
  ) {
    json.MPXStereoDecoder = json.ExtStereoDecoder;
    delete json.ExtStereoDecoder;
  }

  // Remove deprecated "SpectrumAverageLevel" if it exists
  if (typeof json.SpectrumAverageLevel !== "undefined") {
    delete json.SpectrumAverageLevel;
  }

  // Set defaults for missing keys
  const result = {
    sampleRate:
      typeof json.sampleRate !== "undefined"
        ? json.sampleRate
        : defaultConfig.sampleRate,
    MPXboost:
      typeof json.MPXboost !== "undefined"
        ? json.MPXboost
        : defaultConfig.MPXboost,
    MPXmode:
      typeof json.MPXmode !== "undefined"
        ? json.MPXmode
        : defaultConfig.MPXmode,
    MPXStereoDecoder:
      typeof json.MPXStereoDecoder !== "undefined"
        ? json.MPXStereoDecoder
        : defaultConfig.MPXStereoDecoder,
    MPXInputCard:
      typeof json.MPXInputCard !== "undefined"
        ? json.MPXInputCard
        : defaultConfig.MPXInputCard,
    fftLibrary:
      typeof json.fftLibrary !== "undefined"
        ? json.fftLibrary
        : defaultConfig.fftLibrary,
    fftSize:
      typeof json.fftSize !== "undefined"
        ? json.fftSize
        : defaultConfig.fftSize,
    SpectrumAttackLevel:
      typeof json.SpectrumAttackLevel !== "undefined"
        ? json.SpectrumAttackLevel
        : defaultConfig.SpectrumAttackLevel,
    SpectrumDecayLevel:
      typeof json.SpectrumDecayLevel !== "undefined"
        ? json.SpectrumDecayLevel
        : defaultConfig.SpectrumDecayLevel,
    minSendIntervalMs:
      typeof json.minSendIntervalMs !== "undefined"
        ? json.minSendIntervalMs
        : defaultConfig.minSendIntervalMs,
    pilotCalibration:
      typeof json.pilotCalibration !== "undefined"
        ? json.pilotCalibration
        : defaultConfig.pilotCalibration,
    mpxCalibration:
      typeof json.mpxCalibration !== "undefined"
        ? json.mpxCalibration
        : defaultConfig.mpxCalibration,
    rdsCalibration:
      typeof json.rdsCalibration !== "undefined"
        ? json.rdsCalibration
        : defaultConfig.rdsCalibration,
    "Curve-Y-Offset":
      typeof json["Curve-Y-Offset"] !== "undefined"
        ? json["Curve-Y-Offset"]
        : defaultConfig["Curve-Y-Offset"],
    "Curve-Y-Dynamics":
      typeof json["Curve-Y-Dynamics"] !== "undefined"
        ? json["Curve-Y-Dynamics"]
        : defaultConfig["Curve-Y-Dynamics"],
    stereoBoost:
      typeof json.stereoBoost !== "undefined"
        ? json.stereoBoost
        : defaultConfig.stereoBoost,
    eqBoost:
      typeof json.eqBoost !== "undefined"
        ? json.eqBoost
        : defaultConfig.eqBoost,
    MODULE_SEQUENCE:
      typeof json.MODULE_SEQUENCE !== "undefined"
        ? json.MODULE_SEQUENCE
        : defaultConfig.MODULE_SEQUENCE,
    CANVAS_SEQUENCE:
      typeof json.CANVAS_SEQUENCE !== "undefined"
        ? json.CANVAS_SEQUENCE
        : defaultConfig.CANVAS_SEQUENCE,
    LockVolumeSlider:
      typeof json.LockVolumeSlider !== "undefined"
        ? json.LockVolumeSlider
        : defaultConfig.LockVolumeSlider,
    EnableSpectrumOnLoad:
      typeof json.EnableSpectrumOnLoad !== "undefined"
        ? json.EnableSpectrumOnLoad
        : defaultConfig.EnableSpectrumOnLoad,
  };

  // Preserve any extra keys present in the input JSON
  for (const key of Object.keys(json)) {
    if (!(key in result)) {
      result[key] = json[key];
    }
  }

  return result;
}

//-------------------------------------------------------------
//  Load, Create, or Repair Configuration File
//-------------------------------------------------------------
function loadConfig(filePath) {
  const dir = path.dirname(filePath);

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

      json = normalizePluginConfig(json);
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");

      return json;
    } catch (err) {
      logWarn(
        "[MPX] metricsmonitor.json invalid → rewriting with defaults:",
        err.message
      );
      fs.writeFileSync(
        filePath,
        JSON.stringify(defaultConfig, null, 2),
        "utf8"
      );
      return defaultConfig;
    }
  }

  logWarn(
    "[MPX] metricsmonitor.json not found → creating new file with defaults."
  );
  fs.writeFileSync(filePath, JSON.stringify(defaultConfig, null, 2), "utf8");
  return defaultConfig;
}

//-------------------------------------------------------------
//  Configuration Getters (Safe Accessors)
//-------------------------------------------------------------
function getPluginSampleRate(cfg) {
  if (!cfg) return defaultConfig.sampleRate;
  const sr =
    typeof cfg.sampleRate === "string" ? Number(cfg.sampleRate) : cfg.sampleRate;
  return typeof sr === "number" && !Number.isNaN(sr) && sr > 0
    ? sr
    : defaultConfig.sampleRate;
}

function getStereoBoost(cfg) {
  if (!cfg) return defaultConfig.stereoBoost;
  const val =
    typeof cfg.stereoBoost === "string"
      ? Number(cfg.stereoBoost)
      : cfg.stereoBoost;
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig.stereoBoost;
}

function getEqBoost(cfg) {
  if (!cfg) return defaultConfig.eqBoost;
  const val =
    typeof cfg.eqBoost === "string" ? Number(cfg.eqBoost) : cfg.eqBoost;
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig.eqBoost;
}

function getFftLibrary(cfg) {
  if (!cfg) return defaultConfig.fftLibrary;
  const val = String(cfg.fftLibrary).trim();
  if (val === "pffft.wasm" || val === "fft-js") {
    return val;
  }
  return defaultConfig.fftLibrary;
}

function getFftSize(cfg) {
  if (!cfg) return defaultConfig.fftSize;
  const val =
    typeof cfg.fftSize === "string" ? Number(cfg.fftSize) : cfg.fftSize;
  return typeof val === "number" && !Number.isNaN(val) && val > 0
    ? val
    : defaultConfig.fftSize;
}

function getMinSendIntervalMs(cfg) {
  if (!cfg) return defaultConfig.minSendIntervalMs;
  const val =
    typeof cfg.minSendIntervalMs === "string"
      ? Number(cfg.minSendIntervalMs)
      : cfg.minSendIntervalMs;
  return typeof val === "number" && !Number.isNaN(val) && val > 0
    ? val
    : defaultConfig.minSendIntervalMs;
}

function getSpectrumAttackLevel(cfg) {
  if (!cfg) return defaultConfig.SpectrumAttackLevel;
  const val =
    typeof cfg.SpectrumAttackLevel === "string"
      ? Number(cfg.SpectrumAttackLevel)
      : cfg.SpectrumAttackLevel;
  return typeof val === "number" && !Number.isNaN(val) && val > 0
    ? val
    : defaultConfig.SpectrumAttackLevel;
}

function getSpectrumDecayLevel(cfg) {
  if (!cfg) return defaultConfig.SpectrumDecayLevel;
  const val =
    typeof cfg.SpectrumDecayLevel === "string"
      ? Number(cfg.SpectrumDecayLevel)
      : cfg.SpectrumDecayLevel;
  return typeof val === "number" && !Number.isNaN(val) && val > 0
    ? val
    : defaultConfig.SpectrumDecayLevel;
}

function getMpxMode(cfg) {
  if (!cfg || typeof cfg.MPXmode === "undefined") {
    return defaultConfig.MPXmode;
  }
  const val = String(cfg.MPXmode).toLowerCase();
  if (val === "on" || val === "off" || val === "auto") {
    return val;
  }
  return defaultConfig.MPXmode;
}

function getMPXStereoDecoder(cfg) {
  if (!cfg || typeof cfg.MPXStereoDecoder === "undefined") {
    if (typeof cfg.ExtStereoDecoder !== "undefined") {
      return String(cfg.ExtStereoDecoder).toLowerCase();
    }
    return defaultConfig.MPXStereoDecoder;
  }
  const val = String(cfg.MPXStereoDecoder).toLowerCase();
  if (val === "on" || val === "off") {
    return val;
  }
  return defaultConfig.MPXStereoDecoder;
}

function getLockVolumeSlider(cfg) {
  if (!cfg || typeof cfg.LockVolumeSlider === "undefined") {
    return defaultConfig.LockVolumeSlider;
  }
  return cfg.LockVolumeSlider === true;
}

function getEnableSpectrumOnLoad(cfg) {
  if (!cfg || typeof cfg.EnableSpectrumOnLoad === "undefined") {
    return defaultConfig.EnableSpectrumOnLoad;
  }
  return cfg.EnableSpectrumOnLoad === true;
}

function getMPXInputCard(cfg) {
  if (!cfg || typeof cfg.MPXInputCard === "undefined") {
    return defaultConfig.MPXInputCard;
  }
  let s = String(cfg.MPXInputCard).trim();
  s = s.replace(/^["'](.*)["']$/, "$1");
  return s;
}

function getPilotCalibration(cfg) {
  if (!cfg) return defaultConfig.pilotCalibration;
  const val =
    typeof cfg.pilotCalibration === "string"
      ? Number(cfg.pilotCalibration)
      : cfg.pilotCalibration;
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig.pilotCalibration;
}

function getMpxCalibration(cfg) {
  if (!cfg) return defaultConfig.mpxCalibration;
  const val =
    typeof cfg.mpxCalibration === "string"
      ? Number(cfg.mpxCalibration)
      : cfg.mpxCalibration;
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig.mpxCalibration;
}

function getRdsCalibration(cfg) {
  if (!cfg) return defaultConfig.rdsCalibration;
  const val =
    typeof cfg.rdsCalibration === "string"
      ? Number(cfg.rdsCalibration)
      : cfg.rdsCalibration;
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig.rdsCalibration;
}

function getCurveYOffset(cfg) {
  if (!cfg) return defaultConfig["Curve-Y-Offset"];
  const val =
    typeof cfg["Curve-Y-Offset"] === "string"
      ? Number(cfg["Curve-Y-Offset"])
      : cfg["Curve-Y-Offset"];
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig["Curve-Y-Offset"];
}

function getCurveYDynamics(cfg) {
  if (!cfg) return defaultConfig["Curve-Y-Dynamics"];
  const val =
    typeof cfg["Curve-Y-Dynamics"] === "string"
      ? Number(cfg["Curve-Y-Dynamics"])
      : cfg["Curve-Y-Dynamics"];
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig["Curve-Y-Dynamics"];
}

function getMPXBoost(cfg) {
  if (!cfg) return defaultConfig.MPXboost;
  const val =
    typeof cfg.MPXboost === "string" ? Number(cfg.MPXboost) : cfg.MPXboost;
  return typeof val === "number" && !Number.isNaN(val)
    ? val
    : defaultConfig.MPXboost;
}

//-------------------------------------------------------------
//  Load Values from Config
//-------------------------------------------------------------
const configPlugin = loadConfig(configFilePath);

let MODULE_SEQUENCE = configPlugin.MODULE_SEQUENCE;
let CANVAS_SEQUENCE = configPlugin.CANVAS_SEQUENCE;
const ANALYZER_SAMPLE_RATE = getPluginSampleRate(configPlugin);
const CONFIG_SAMPLE_RATE = ANALYZER_SAMPLE_RATE;
const STEREO_BOOST = getStereoBoost(configPlugin);
const EQ_BOOST = getEqBoost(configPlugin);
const FFT_LIBRARY = getFftLibrary(configPlugin);
const FFT_SIZE = getFftSize(configPlugin);
const MIN_SEND_INTERVAL_MS = getMinSendIntervalMs(configPlugin);

// ITU-R BS.412 / SM.1268 Settings
const DEV_LIMIT_KHZ = Number(configPlugin?.DevLimitKHz ?? 75);
const DEV_REF_KHZ = Number(configPlugin?.DevRefKHz ?? 19);
const DEV_UNC_KHZ = Number(configPlugin?.DevUncKHz ?? 2);

// Scaling constants
const DEV_SCALE_KHZ_PER_AMP = Number(configPlugin?.DevScaleKHzPerAmp ?? 950);
const DEV_INT_WINDOW_MS = 20;

let devIntAcc = 0;
let devIntSamples = 0;

const MODPOWER_WINDOW_S = 60;
let mpBlockQueue = [];
let mpIntegral60 = 0;
let mpDur60 = 0;

let devSamplesTotal = 0;
let devSamplesExceed = 0;

const SPECTRUM_ATTACK_LEVEL = getSpectrumAttackLevel(configPlugin);
const SPECTRUM_DECAY_LEVEL = getSpectrumDecayLevel(configPlugin);
const MPX_MODE = getMpxMode(configPlugin);
const MPX_STEREO_DECODER = getMPXStereoDecoder(configPlugin);
const MPX_INPUT_CARD = getMPXInputCard(configPlugin);
const LOCK_VOLUME_SLIDER = getLockVolumeSlider(configPlugin);
const ENABLE_SPECTRUM_ON_LOAD = getEnableSpectrumOnLoad(configPlugin);
const MPX_BOOST = getMPXBoost(configPlugin);
const PILOT_CALIBRATION = getPilotCalibration(configPlugin);
const MPX_CALIBRATION = getMpxCalibration(configPlugin);
const RDS_CALIBRATION = getRdsCalibration(configPlugin);
const CURVE_Y_OFFSET = getCurveYOffset(configPlugin);
const CURVE_Y_DYNAMICS = getCurveYDynamics(configPlugin);

//-------------------------------------------------------------
//  Check if modules are enabled
//-------------------------------------------------------------
function hasAnalyzerOrMeters(config) {
  const raw =
    config && typeof config.MODULE_SEQUENCE !== "undefined"
      ? config.MODULE_SEQUENCE
      : defaultConfig.MODULE_SEQUENCE;

  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    arr = String(raw)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }
  return arr.some((v) => Number(v) === 1) || arr.some((v) => Number(v) === 2);
}

function hasMpxInCanvas(config) {
  const raw =
    config && typeof config.CANVAS_SEQUENCE !== "undefined"
      ? config.CANVAS_SEQUENCE
      : defaultConfig.CANVAS_SEQUENCE;

  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    arr = String(raw)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }
  return arr.some((v) => Number(v) === 2);
}

const ENABLE_MPX =
  hasAnalyzerOrMeters(configPlugin) || hasMpxInCanvas(configPlugin);
const ENABLE_ANALYZER = ENABLE_MPX;

//-------------------------------------------------------------
//  Dependency Check and Installation
//-------------------------------------------------------------
const RequiredModules = [
  "fft-js",
  "bit-twiddle",
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

//-------------------------------------------------------------
//  Patch 3LAS Server for Configurable Sample Rate
//-------------------------------------------------------------
function patch3LAS() {
  try {
    const filePath = path.resolve(
      __dirname,
      "../../server/stream/3las.server.js"
    );
    let content = fs.readFileSync(filePath, "utf8");

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
      logInfo(
        "[MPX] 3LAS old sampleRate block not found – no changes applied."
      );
    }
  } catch (err) {
    logError("[MPX] Failed to patch 3las.server.js:", err);
  }
}

//-------------------------------------------------------------
//  Patch helpers.js to Bypass Localhost Anti-Spam
//-------------------------------------------------------------
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
      logInfo(
        "[MPX] helpers.js already contains localhost bypass – nothing to do."
      );
      return;
    }

    const fnSignature =
      "function antispamProtection(message, clientIp, ws, userCommands, lastWarn, userCommandHistory, lengthCommands, endpointName) {";
    const fnIndex = content.indexOf(fnSignature);

    if (fnIndex === -1) {
      logWarn(
        "[MPX] antispamProtection() not found in helpers.js – skipping localhost patch."
      );
      return;
    }

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

//-------------------------------------------------------------
//  ITU-R BS.412 Deviation Scaling and Normalization
//-------------------------------------------------------------
const DEV_FULL_SCALE_KHZ = 75.0;
const DEV_CALIBRATION = Number(configPlugin?.DevCalibrationKHz || 0);

function normalizeSequence(seq) {
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

const MODULE_SEQUENCE_JS = normalizeSequence(MODULE_SEQUENCE);
const CANVAS_SEQUENCE_JS = normalizeSequence(CANVAS_SEQUENCE);

// Client script paths
const MetricsMonitorClientFile = path.join(__dirname, "metricsmonitor.js");
const MetricsMonitorClientAnalyzerFile = path.join(
  __dirname,
  "js/metricsmonitor-analyzer.js"
);
const MetricsMonitorClientMetersFile = path.join(
  __dirname,
  "js/metricsmonitor-meters.js"
);
const MetricsMonitorClientEqualizerFile = path.join(
  __dirname,
  "js/metricsmonitor-equalizer.js"
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

//-------------------------------------------------------------
//  Update Client-Side Scripts
//  Injects configuration constants directly into JS files.
//-------------------------------------------------------------
function updateSettings() {
  function buildHeaderBlock() {
    return (
      `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const CANVAS_SEQUENCE = ${CANVAS_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const sampleRate = ${ANALYZER_SAMPLE_RATE};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXboost = ${MPX_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXmode = "${MPX_MODE}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXStereoDecoder = "${MPX_STEREO_DECODER}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const MPXInputCard = "${MPX_INPUT_CARD}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const fftLibrary = "${FFT_LIBRARY}";    // Do not touch - this value is automatically updated via the config file\n` +
      `const fftSize = ${FFT_SIZE};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumAttackLevel = ${SPECTRUM_ATTACK_LEVEL};    // Do not touch - this value is automatically updated via the config file\n` +
      `const SpectrumDecayLevel = ${SPECTRUM_DECAY_LEVEL};    // Do not touch - this value is automatically updated via the config file\n` +
      `const minSendIntervalMs = ${MIN_SEND_INTERVAL_MS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const pilotCalibration = ${PILOT_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
      `const mpxCalibration = ${MPX_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
      `const rdsCalibration = ${RDS_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
      `const CurveYOffset = ${CURVE_Y_OFFSET};    // Do not touch - this value is automatically updated via the config file\n` +
      `const CurveYDynamics = ${CURVE_Y_DYNAMICS};    // Do not touch - this value is automatically updated via the config file\n` +
      `const stereoBoost = ${STEREO_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
      `const eqBoost = ${EQ_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
      `const LockVolumeSlider = ${LOCK_VOLUME_SLIDER};    // Do not touch - this value is automatically updated via the config file\n` +
      `const EnableSpectrumOnLoad = ${ENABLE_SPECTRUM_ON_LOAD};    // Do not touch - this value is automatically updated via the config file\n`
    );
  }

  function removeOldConstants(code) {
    let out = code
      .replace(/^\s*const\s+MODULE_SEQUENCE\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+CANVAS_SEQUENCE\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+sampleRate\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXboost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+stereoBoost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+eqBoost\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+fftLibrary\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+fftSize\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumAverageLevel\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumAttackLevel\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+SpectrumDecayLevel\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+minSendIntervalMs\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+pilotCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+mpxCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+rdsCalibration\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+CurveYOffset\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+CurveYDynamics\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXmode\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+ExtStereoDecoder\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXStereoDecoder\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+MPXInputCard\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+LockVolumeSlider\s*=.*;[^\n]*\n?/gm, "")
      .replace(/^\s*const\s+EnableSpectrumOnLoad\s*=.*;[^\n]*\n?/gm, "");

    out = out.replace(
      /^\s*\/\/\s*Do not touch - this value is automatically updated via the config file\s*$/gm,
      ""
    );

    return out;
  }

  function insertAfterIIFE(code) {
    const cleaned = removeOldConstants(code);
    const iifePattern = /(\(\s*\)\s*=>\s*\{)[ \t]*\n?/;

    if (!iifePattern.test(cleaned)) {
      logWarn("[MPX] Could not find IIFE in script – no header injected.");
      return cleaned;
    }

    return cleaned.replace(
      iifePattern,
      (_, prefix) => `${prefix}\n${buildHeaderBlock()}`
    );
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
    MetricsMonitorClientEqualizerFile,
    "metricsmonitor-equalizer.js",
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
    insertAfterIIFE
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

//-------------------------------------------------------------
//  Deploy Client Files (Linux/macOS)
//-------------------------------------------------------------
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

// Execute File Updates
updateSettings();
copyClientFiles();

//-------------------------------------------------------------
//  Main Server Logic
//-------------------------------------------------------------
if (!ENABLE_MPX) {
  logInfo(
    `[MPX] MODULE_SEQUENCE = ${MODULE_SEQUENCE} → ` +
    "MPX capture & server-side MPX processing are disabled."
  );
} else {
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

  // Initialize FFT Library
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
    `[MPX] SpectrumAttackLevel from metricsmonitor.json → ${SPECTRUM_ATTACK_LEVEL}`
  );
  logInfo(
    `[MPX] SpectrumDecayLevel from metricsmonitor.json → ${SPECTRUM_DECAY_LEVEL}`
  );
  logInfo(
    `[MPX] minSendIntervalMs from metricsmonitor.json → ${MIN_SEND_INTERVAL_MS} ms`
  );
  logInfo(`[MPX] MPXmode from metricsmonitor.json → ${MPX_MODE}`);
  logInfo(
    `[MPX] MPXStereoDecoder from metricsmonitor.json → ${MPX_STEREO_DECODER}`
  );
  logInfo(`[MPX] MPXboost from metricsmonitor.json → ${MPX_BOOST}`);
  if (MPX_INPUT_CARD !== "") {
    logInfo(`[MPX] MPXInputCard from metricsmonitor.json → "${MPX_INPUT_CARD}"`);
  }

  // Determine OS and Binary Path
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

  //-----------------------------------------------------------
  //  WebSocket: Data Connection
  //-----------------------------------------------------------
  let dataPluginsWs = null;
  let reconnectTimer = null;
  let backpressureHits = 0;
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

  //-----------------------------------------------------------
  //  Processing Buffers and Variables
  //-----------------------------------------------------------
  let use3LasPcmFormat = false;
  let sampleBuffer = [];

  const GOERTZEL_WINDOW_SIZE = 4096;
  let goertzelAccumulator = [];
  let goertzelWindow = null;
  let debugLogCounter = 0;

  let currentMaxPeak = 0;
  let currentPilotPeak = 0;
  let currentRdsPeak = 0;
  let currentNoiseFloor = 0;

  const GOERTZEL_PILOT_FREQ = 19000;
  const GOERTZEL_RDS_FREQ_1 = 56000;
  const GOERTZEL_RDS_FREQ_2 = 57000;
  const GOERTZEL_RDS_FREQ_3 = 58000;
  const GOERTZEL_NOISE_FREQ = 25000;

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

  function initGoertzelWindow() {
    goertzelWindow = new Float32Array(GOERTZEL_WINDOW_SIZE);
    for (let i = 0; i < GOERTZEL_WINDOW_SIZE; i++) {
      goertzelWindow[i] =
        0.5 * (1 - Math.cos((2 * Math.PI * i) / (GOERTZEL_WINDOW_SIZE - 1)));
    }
    logInfo(
      `[MPX] Precision Analyzer initialized. Window Size: ${GOERTZEL_WINDOW_SIZE}`
    );
  }

  //-----------------------------------------------------------
  //  Goertzel Algorithm Implementation
  //-----------------------------------------------------------
  function calculateGoertzelWindowed(samples, targetFreq, sampleRate) {
    if (sampleRate < 1000) return 0;

    const omega = (2.0 * Math.PI * targetFreq) / sampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const coeff = 2.0 * cosine;

    let q0 = 0,
      q1 = 0,
      q2 = 0;

    for (let i = 0; i < samples.length; i++) {
      const windowedSample = samples[i] * goertzelWindow[i];
      q0 = coeff * q1 - q2 + windowedSample;
      q2 = q1;
      q1 = q0;
    }

    const real = q1 - q2 * cosine;
    const imag = q2 * sine;

    return (Math.sqrt(real * real + imag * imag) * 2.0) / samples.length * 2.0;
  }

  //-----------------------------------------------------------
  //  PCM Data Handling
  //-----------------------------------------------------------
  function handlePcmChunk(chunk) {
    if (!chunk || chunk.length === 0) return;

    if (!goertzelWindow && SAMPLE_RATE > 0) {
      initGoertzelWindow();
    }

    let processingBuffer = [];

    // Decode PCM Data
    if (use3LasPcmFormat) {
      const intData = new Int16Array(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength / 2
      );
      for (let i = 0; i < intData.length; i += 2) {
        const L = intData[i] / 32768.0;
        const R = (intData[i + 1] ?? intData[i]) / 32768.0;
        const mono = (L + R) * 0.5;
        if (ENABLE_ANALYZER) sampleBuffer.push(mono);
        processingBuffer.push(mono);
      }
    } else {
      const floatData = new Float32Array(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength / 4
      );
      for (let i = 0; i < floatData.length; i += 2) {
        const L = floatData[i];
        const R = floatData[i + 1] ?? L;
        const mono = (L + R) * 0.5;
        if (ENABLE_ANALYZER) sampleBuffer.push(mono);
        processingBuffer.push(mono);
      }
    }

    // Fast Time Domain Analysis
    let chunkMax = 0;
    let sumSq = 0;
    let exceed = 0;

    for (let i = 0; i < processingBuffer.length; i++) {
      const val = processingBuffer[i];
      const absVal = Math.abs(val);

      if (absVal > chunkMax) chunkMax = absVal;
      sumSq += val * val;

      const devKHz = absVal * DEV_SCALE_KHZ_PER_AMP;
      if (devKHz > DEV_LIMIT_KHZ + DEV_UNC_KHZ) exceed++;

      if (goertzelWindow) goertzelAccumulator.push(val);
    }

    if (chunkMax > currentMaxPeak) {
      currentMaxPeak = chunkMax;
    }

    devSamplesTotal += processingBuffer.length;
    devSamplesExceed += exceed;

    const durS = processingBuffer.length / SAMPLE_RATE;
    const k = DEV_SCALE_KHZ_PER_AMP / DEV_REF_KHZ;
    const integral = (sumSq / SAMPLE_RATE) * (k * k);

    mpBlockQueue.push({ durS, integral });
    mpIntegral60 += integral;
    mpDur60 += durS;

    while (mpDur60 > MODPOWER_WINDOW_S && mpBlockQueue.length) {
      const old = mpBlockQueue.shift();
      mpIntegral60 -= old.integral;
      mpDur60 -= old.durS;
    }

    // Precision Frequency Domain Analysis
    if (goertzelAccumulator.length > GOERTZEL_WINDOW_SIZE * 4) {
      goertzelAccumulator = goertzelAccumulator.slice(-GOERTZEL_WINDOW_SIZE);
    }

    while (goertzelAccumulator.length >= GOERTZEL_WINDOW_SIZE) {
      const analysisChunk = goertzelAccumulator.slice(0, GOERTZEL_WINDOW_SIZE);
      const overlap = Math.floor(GOERTZEL_WINDOW_SIZE * 0.5);
      goertzelAccumulator = goertzelAccumulator.slice(overlap);

      const pilotMag = calculateGoertzelWindowed(
        analysisChunk,
        19000,
        SAMPLE_RATE
      );

      // RDS Scan
      const rds56k = calculateGoertzelWindowed(
        analysisChunk,
        56000,
        SAMPLE_RATE
      );
      const rds56_5k = calculateGoertzelWindowed(
        analysisChunk,
        56500,
        SAMPLE_RATE
      );
      const rds57k = calculateGoertzelWindowed(
        analysisChunk,
        57000,
        SAMPLE_RATE
      );
      const rds57_5k = calculateGoertzelWindowed(
        analysisChunk,
        57500,
        SAMPLE_RATE
      );
      const rds58k = calculateGoertzelWindowed(
        analysisChunk,
        58000,
        SAMPLE_RATE
      );

      const rawRdsEnergy = Math.max(
        rds56k,
        rds56_5k,
        rds57k,
        rds57_5k,
        rds58k
      );

      // Noise Floor Calc
      const noiseRef70k = calculateGoertzelWindowed(
        analysisChunk,
        70000,
        SAMPLE_RATE
      );

      currentNoiseFloor = currentNoiseFloor * 0.95 + noiseRef70k * 0.05;

      // RDS Validity Check
      let validRds = rawRdsEnergy - noiseRef70k * 0.5;
      if (validRds < 0) validRds = 0;

      const SMOOTHING_FACTOR = 0.85;
      currentPilotPeak =
        currentPilotPeak * SMOOTHING_FACTOR + pilotMag * (1 - SMOOTHING_FACTOR);

      const diff = Math.abs(validRds - currentRdsPeak);
      const threshold = currentRdsPeak * 0.03;

      if (diff > threshold) {
        currentRdsPeak = currentRdsPeak * 0.9 + validRds * 0.1;
      } else {
        currentRdsPeak = currentRdsPeak * 0.98 + validRds * 0.02;
      }

      if (currentPilotPeak < 0.0002) {
        currentRdsPeak = 0;
      }
    }

    // Perform FFT
    if (ENABLE_ANALYZER && fftReady) {
      const maxSamples = MAX_LATENCY_BLOCKS * FFT_SIZE;
      if (sampleBuffer.length > maxSamples)
        sampleBuffer.splice(0, sampleBuffer.length - maxSamples);

      if (sampleBuffer.length >= FFT_SIZE) {
        const start = sampleBuffer.length - FFT_SIZE;
        for (let i = 0; i < FFT_SIZE; i++)
          fftBlock[i] = sampleBuffer[start + i] * windowHann[i];
        const keepFrom = Math.max(0, sampleBuffer.length - HOP_SIZE);
        if (keepFrom > 0) sampleBuffer.splice(0, keepFrom);
        else sampleBuffer.length = 0;

        let mags = null;
        const halfLen = FFT_SIZE / 2;

        if (FFT_LIBRARY === "pffft.wasm" && pffftModule) {
          pffftInputHeap.set(fftBlock);
          pffftModule._pffft_transform_ordered(
            pffftSetup,
            pffftInputPtr,
            pffftOutputPtr,
            pffftWorkPtr,
            0
          );

          mags = new Float32Array(halfLen);
          for (let i = 0; i < halfLen; i++) {
            const re = pffftOutputHeap[2 * i];
            const im = pffftOutputHeap[2 * i + 1];
            let mag = Math.sqrt(re * re + im * im) / (FFT_SIZE / 2);
            if (i > 0) mag *= 10;
            mags[i] = mag;
          }
        } else if (FFT) {
          const phasors = FFT(fftBlock);
          mags = new Float32Array(halfLen);
          for (let i = 0; i < halfLen; i++) {
            const re = phasors[i][0];
            const im = phasors[i][1];
            let mag = Math.sqrt(re * re + im * im) / (FFT_SIZE / 2);
            if (i > 0) mag *= 10;
            mags[i] = mag;
          }
        }

        if (mags) {
          const mpx = [];
          for (let i = 0; i < halfLen; i += BIN_STEP) {
            const f = (i * SAMPLE_RATE) / FFT_SIZE;
            if (f > 100000) break;
            let sum = 0;
            let count = 0;
            for (let k = 0; k < BIN_STEP && i + k < halfLen; k++) {
              sum += mags[i + k];
              count++;
            }
            const avgMag = sum / (count || 1);
            const boosted =
              avgMag * (1 + (typeof MPX_BOOST === "number" ? MPX_BOOST : 0));
            // Reduced format: send only magnitude (not {f, m} object) to reduce network traffic by ~85%
            // Round to 5 decimal places to further reduce data size while maintaining precision
            mpx.push(Math.round(boosted * 100000) / 100000);
          }
          if (mpx.length > 0) latestMpxFrame = mpx;
        }
      }
    }
  }

  //-----------------------------------------------------------
  //  Capture Start Logic (3LAS vs MPXCapture)
  //-----------------------------------------------------------
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

  //-----------------------------------------------------------
  //  RDS Validation Logic
  //-----------------------------------------------------------
  function computeRdsFromPilot(sendPilot, sendRds) {
    const EPS = 1e-9;
    const PILOT_MIN_AMP = 0.0025;
    const RDS_RATIO_MIN = 0.006;
    const PILOT_SCALE_KHZ_PER_AMP = 9.5;
    const PILOT_CALIBRATION = 0;

    const pilotKHz = sendPilot * PILOT_SCALE_KHZ_PER_AMP + PILOT_CALIBRATION;
    const rdsRatio = sendPilot > EPS ? sendRds / sendPilot : 0;
    const rdsValid = sendPilot >= PILOT_MIN_AMP && rdsRatio >= RDS_RATIO_MIN;
    const rdsKHzNorm = rdsValid ? rdsRatio * pilotKHz : 0;

    return {
      rdsValid,
      rdsRatio,
      rdsKHzNorm,
      pilotKHz,
    };
  }

  //-----------------------------------------------------------
  //  Main Sending Loop
  //-----------------------------------------------------------
  let smoothedPilot = 0;
  let smoothedNoise = 0.0001;
  let squelchState = false;
  let squelchDropCount = 0;

  let mpxDisplayPeak = 0;
  let mpxHoldTimer = 0;
  let ituIntegrator = 0;

  const PILOT_SCALE_KHZ_PER_AMP = 950.0;
  const RDS_SCALE_KHZ_PER_AMP = 10000.0;

  const PEAK_HOLD_TIME_MS = 200;
  const RELEASE_SPEED_KHZ_SEC = 60.0;

  const FRAMES_PER_SEC = 1000 / MIN_SEND_INTERVAL_MS;
  const HOLD_FRAMES = Math.round((PEAK_HOLD_TIME_MS / 1000) * FRAMES_PER_SEC);
  const DECAY_PER_FRAME =
    RELEASE_SPEED_KHZ_SEC / FRAMES_PER_SEC / DEV_SCALE_KHZ_PER_AMP;

  const RDS_AVG_SIZE = 16;
  const rdsHistory = new Float32Array(RDS_AVG_SIZE);
  let rdsHistoryIdx = 0;
  let rdsHistoryFilled = false;

  const PERC_WINDOW_MS = 2000;
  const PERC = 0.95;
  const PERC_SAMPLES = Math.max(
    4,
    Math.round(PERC_WINDOW_MS / MIN_SEND_INTERVAL_MS)
  );
  const percBuffer = new Float32Array(PERC_SAMPLES);
  let percIdx = 0;
  let percCount = 0;

  function percentileFromBuffer(buf, count, q) {
    if (count === 0) return 0;
    const a = Array.from(buf.subarray(0, count));
    a.sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos),
      hi = Math.ceil(pos);
    if (hi === lo) return a[lo];
    return a[lo] * (hi - pos) + a[hi] * (pos - lo);
  }

  setInterval(() => {
    if (!dataPluginsWs || dataPluginsWs.readyState !== WebSocket.OPEN) return;
    if (dataPluginsWs.bufferedAmount > MAX_WS_BACKLOG_BYTES) {
      if (++backpressureHits >= MAX_BACKPRESSURE_HITS) {
        try {
          dataPluginsWs.terminate();
        } catch {}
        dataPluginsWs = null;
      }
      return;
    }
    backpressureHits = 0;

    // Squelch / Noise Gate Logic
    if (currentPilotPeak > 0) {
      smoothedPilot = smoothedPilot * 0.9 + currentPilotPeak * 0.1;
    } else {
      smoothedPilot = 0;
    }

    smoothedNoise = smoothedNoise * 0.95 + currentNoiseFloor * 0.05;
    const stableSnr = smoothedPilot / Math.max(0.000001, smoothedNoise);
    const isPilotStrongEnough = smoothedPilot > 0.001;

    if (squelchState) {
      if (stableSnr < 2.5 || !isPilotStrongEnough) {
        if (++squelchDropCount > 15) squelchState = false;
      } else {
        squelchDropCount = 0;
      }
    } else {
      if (stableSnr > 4.0 && isPilotStrongEnough) {
        squelchState = true;
        squelchDropCount = 0;
      }
    }

    // ITU Integration
    let rawInputAmp = squelchState ? currentMaxPeak : 0;

    if (rawInputAmp > ituIntegrator) {
      ituIntegrator = ituIntegrator * 0.4 + rawInputAmp * 0.6;
    } else {
      ituIntegrator = ituIntegrator * 0.8;
    }

    // Percentile Baseline Calculation
    percBuffer[percIdx] = ituIntegrator;
    percIdx = (percIdx + 1) % PERC_SAMPLES;
    if (percCount < PERC_SAMPLES) percCount++;

    const stableAmp = percentileFromBuffer(percBuffer, percCount, PERC);

    const STABLE_BLEND = 0.85;
    const SHORT_BLEND = 1 - STABLE_BLEND;
    const shortTerm = ituIntegrator;
    const combinedInput = stableAmp * STABLE_BLEND + shortTerm * SHORT_BLEND;

    // Analog Needle Simulation
    if (typeof analogNeedle === "undefined") analogNeedle = 0;

    if (combinedInput > analogNeedle) {
      analogNeedle = analogNeedle * 0.75 + combinedInput * 0.25;
    } else {
      analogNeedle = analogNeedle * 0.78 + combinedInput * 0.22;
    }

    // Peak Hold Logic
    if (typeof mpxDisplayPeak === "undefined") mpxDisplayPeak = 0;
    if (typeof mpxHoldTimer === "undefined") mpxHoldTimer = 0;

    if (analogNeedle > mpxDisplayPeak) {
      mpxDisplayPeak = analogNeedle;
      mpxHoldTimer = HOLD_FRAMES;
    } else {
      if (mpxHoldTimer > 0) {
        mpxHoldTimer--;
      } else {
        mpxDisplayPeak = Math.max(
          analogNeedle,
          mpxDisplayPeak - DECAY_PER_FRAME
        );
      }
    }

    const maxOvershoot = 5 / DEV_SCALE_KHZ_PER_AMP;
    if (mpxDisplayPeak > analogNeedle + maxOvershoot) {
      mpxDisplayPeak = analogNeedle + maxOvershoot;
    }

    // RDS Averaging
    let sendRds = 0;
    if (squelchState) {
      rdsHistory[rdsHistoryIdx] = currentRdsPeak;
      rdsHistoryIdx = (rdsHistoryIdx + 1) % RDS_AVG_SIZE;
      if (rdsHistoryIdx === 0) rdsHistoryFilled = true;

      let sum = 0;
      const count = rdsHistoryFilled ? RDS_AVG_SIZE : rdsHistoryIdx;
      for (let i = 0; i < count; i++) sum += rdsHistory[i];
      sendRds = count > 0 ? sum / count : currentRdsPeak;
    } else {
      rdsHistory.fill(0);
      rdsHistoryFilled = false;
      rdsHistoryIdx = 0;
      sendRds = 0;
    }

    const sendPilot = squelchState ? currentPilotPeak : 0;

    // Final Calculations
    const pilotKHz = sendPilot * PILOT_SCALE_KHZ_PER_AMP + PILOT_CALIBRATION;

    let rdsKHz = 0;
    if (sendPilot > 0.002) {
      const CORRECTION_FACTOR = RDS_SCALE_KHZ_PER_AMP / PILOT_SCALE_KHZ_PER_AMP;
      const rdsRatio = sendRds / sendPilot;

      if (rdsRatio > 0.01) {
        rdsKHz = rdsRatio * CORRECTION_FACTOR * pilotKHz + RDS_CALIBRATION;
      }
    }

    const mpxDisplayKHz =
      mpxDisplayPeak * DEV_SCALE_KHZ_PER_AMP + MPX_CALIBRATION;
    const rawSpikeKHz = rawInputAmp * DEV_SCALE_KHZ_PER_AMP + MPX_CALIBRATION;

    if (ENABLE_EXTENDED_LOGGING) {
      if (typeof global.extendedDebugCounter === "undefined")
        global.extendedDebugCounter = 0;
      if (++global.extendedDebugCounter % 33 === 0) {
        console.log(
          "---------------------------------------------------------------"
        );
        console.log(`[DEBUG] Time: ${new Date().toISOString()}`);
        console.log(
          `[DEBUG] MPX Display: ${mpxDisplayKHz.toFixed(
            2
          )} kHz (raw spike: ${rawSpikeKHz.toFixed(1)})`
        );
        console.log(`[DEBUG] Pilot:       ${pilotKHz.toFixed(3)} kHz`);
        console.log(`[DEBUG] RDS:         ${rdsKHz.toFixed(3)} kHz`);
        console.log(
          "---------------------------------------------------------------"
        );
      }
    }

    const devPeakRawKHz = currentMaxPeak * DEV_SCALE_KHZ_PER_AMP;
    const modPower_dBr =
      mpDur60 > 1
        ? 10 * Math.log10((2 / MODPOWER_WINDOW_S) * mpIntegral60)
        : -99;
    const devExceedPct =
      devSamplesTotal > 0 ? (100 * devSamplesExceed) / devSamplesTotal : 0;

    // Construct Payload
    const payload = JSON.stringify({
      type: "MPX",
      value: latestMpxFrame || [],

      peak: mpxDisplayKHz,

      pilot: sendPilot,
      pilotKHz: pilotKHz,

      rds: sendRds,
      rdsKHz: rdsKHz,

      noise: currentNoiseFloor,
      snr: stableSnr,

      devPeakRawKHz,
      devPpmKHz: mpxDisplayKHz,
      devLimitKHz: DEV_LIMIT_KHZ,
      devRefKHz: DEV_REF_KHZ,
      devUncKHz: DEV_UNC_KHZ,
      modPower_dBr,
      devExceedPct,
    });

    currentMaxPeak = 0;
    dataPluginsWs.send(payload, () => {});
  }, MIN_SEND_INTERVAL_MS);

  // Cleanup handler
  if (FFT_LIBRARY === "pffft.wasm") {
    process.on("exit", () => {
      if (pffftModule && pffftSetup) {
        try {
          pffftModule._pffft_destroy_setup(pffftSetup);
          pffftModule._pffft_aligned_free(pffftInputPtr);
          pffftModule._pffft_aligned_free(pffftOutputPtr);
          pffftModule._pffft_aligned_free(pffftWorkPtr);
        } catch (e) {
          // ignore cleanup errors
        }
      }
    });
  }
}