///////////////////////////////////////////////////////////////
/// Upper Section: Stereo / ECC / PTY / TA / TP / RDS       ///
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

  // PTY code → human-readable label mapping
  const PTY_TABLE = [
    "PTY", "News", "Current Affairs", "Info",
    "Sport", "Education", "Drama", "Culture", "Science", "Varied",
    "Pop Music", "Rock Music", "Easy Listening", "Light Classical",
    "Serious Classical", "Other Music", "Weather", "Finance",
    "Children's Programmes", "Social Affairs", "Religion", "Phone-in",
    "Travel", "Leisure", "Jazz Music", "Country Music", "National Music",
    "Oldies Music", "Folk Music", "Documentary"
  ];

  let TextSocket = null;

  // Last real stereo state from the signal
  let prevStereoState = false;
  
  // Track if we are currently in forced mono state (based on socket message)
  let currentIsForced = false;

  // Track B2 State and Click Lock
  let b2Active = false;
  let isClickLocked = false;

  // Previous RDS state (for ramping meter on change)
  let prevRdsState = false;

  // Simple logging helpers
  function logInfo(...msg) {
    console.log('[MetricsHeader]', ...msg);
  }

  function logError(...msg) {
    console.error('[MetricsHeader]', ...msg);
  }

  // Helper: only change icon src when it actually changed
  function setIconSrc(img, src) {
    if (!img) return;
    if (img.dataset.currentSrc === src) return;
    img.src = src;
    img.dataset.currentSrc = src;
  }

  // Called from metricsmonitor.js after sending L0 / L1 / B0 / B1 / B2
  function setMonoLockFromMode(cmdRaw) {
    const cmd = String(cmdRaw).trim().toUpperCase();

    if (cmd === "L1") {
      logInfo('L1 command received.');
    } else if (cmd === "L0") {
      logInfo('L0 command received.');
    } else if (cmd === "B2") {
      logInfo('B2 received: Click disabled, B2 Mode active.');
      b2Active = true;
      isClickLocked = true;
      // Force update icon if we have the last state
      // (Wait for next socket message or trigger update manually if needed)
    } else if (cmd === "B0" || cmd === "B1") {
      logInfo(`${cmd} received: Click enabled, B2 Mode inactive.`);
      b2Active = false;
      isClickLocked = false;
    }
  }

  /**
   * Handle incoming JSON messages from the WebSocket
   * and update meters / icons / labels in the header.
   */
  function handleTextSocketMessage(message) {
      
    // console.log(message.st, message.stForced);  
      
    const meters = window.MetricsMeters;
    if (!meters) return;
    const { levels, updateMeter } = meters;

    // --- HF level (signal strength) ---
    if (message.sig !== undefined) {
      levels.hf = Math.round((message.sig - 7) * 10) / 10;
      updateMeter('hf-meter', levels.hf);
    }

    // --- PTY label (Programme Type) ---
    if (message.pty !== undefined) {
      let ptyIndex = Number(message.pty);
      if (Number.isNaN(ptyIndex) || ptyIndex < 0 || ptyIndex >= PTY_TABLE.length) {
        ptyIndex = 0;
      }
      const ptyText = PTY_TABLE[ptyIndex];

      const ptyLabel = document.getElementById('ptyLabel');
      if (ptyLabel) {
        ptyLabel.textContent = ptyText;
        if (ptyText === "PTY") {
          // No valid PTY → greyed "PTY"
          ptyLabel.style.color = "#696969";
          ptyLabel.style.borderColor = "#696969";
          ptyLabel.style.fontWeight = "bold";
        } else {
          // Valid PTY → normal white text
          ptyLabel.style.color = "#fff";
          ptyLabel.style.borderColor = "#fff";
          ptyLabel.style.fontWeight = "normal";
        }
      }

      // Background color of the signal panel depending on PTY presence
      const panel = document.getElementById('signalPanel');
      if (panel) {
        if (ptyText !== "PTY") {
          panel.style.setProperty('background-color', 'var(--color-2-transparent)', 'important');
        } else {
          panel.style.setProperty('background-color', 'var(--color-1-transparent)', 'important');
        }
      }
    }

    // --- Stereo / Mono indicator (message.st & message.stForced) ---
    if (message.st !== undefined) {
      const isStereo = (message.st === true || message.st === 1);
      // Assume stForced might be undefined if not sent, treat as false if missing
      const isForced = (message.stForced === true || message.stForced === 1);

      // Update global state for click handler
      currentIsForced = isForced;
      prevStereoState = isStereo;

      // Update MetricsMeters logic (Pilot Meter)
      if (window.MetricsMeters && typeof window.MetricsMeters.setStereoStatus === 'function') {
          window.MetricsMeters.setStereoStatus(isStereo);
      }

      const stereoIcon = document.getElementById('stereoIcon');
      let iconName = '';

      // 1. Priority: B2 Mode Logic
      if (b2Active) {
        if (MPXStereoDecoder === "off") {
            // "Wenn b2 ... und MPXStereoDecoder: off -> mono_on.png"
            iconName = 'mpx_on.png';
        } else if (MPXStereoDecoder === "on") {
            // "MPXStereoDecoder: on und b2 ... und st=true und stForced=false -> stereo_off.png"
            if (isStereo && !isForced) {
                iconName = 'stereo_off.png';
            } 
            // "MPXStereoDecoder: on und b2 ... und st=false und stForced=true -> stereo_on.png"
            else if (!isStereo && isForced) {
                iconName = 'stereo_on.png';
            }
        }
      }

      // 2. Standard Logic (if no B2 rule applied)
      if (!iconName) {
        // "message.st = false und message.stForced = false dann mono_off.png"
        if (!isStereo && !isForced) {
            iconName = 'mono_off.png';
        } 
        else if (isStereo && !isForced) {
            iconName = 'stereo_on.png';
        } 
        else if (!isStereo && isForced) {
            iconName = 'mono_off.png';
        } 
        else if (isStereo && isForced) {
            iconName = 'mono_on.png';
        }
      }

      // Default fallback if still empty
      if (!iconName) iconName = 'mono_off.png';

      // Update Cursor style based on lock
      if (stereoIcon) {
          // Allow pointer if MPXStereoDecoder is on (toggling allowed even if B2 locked)
          // OR if MPXmode is off (legacy override)
          if (MPXStereoDecoder === "on" || MPXmode === "off") {
               stereoIcon.style.cursor = 'pointer';
          } else {
               stereoIcon.style.cursor = isClickLocked ? 'default' : 'pointer';
          }
      }

      setIconSrc(stereoIcon, `/js/plugins/MetricsMonitor/images/${iconName}`);
    }

    // --- ECC (Extended Country Code) badge ---
    const eccWrapper = document.getElementById('eccWrapper');
    if (eccWrapper) {
      // Clear previous content each update
      eccWrapper.innerHTML = "";

      // Decide if there is a usable ECC flag.
      const eccSpan = document.querySelector('.data-flag');
      const eccSpanHasContent = eccSpan && eccSpan.innerHTML && eccSpan.innerHTML.trim() !== "";

      let eccSpanIsPlaceholderUN = false;
      if (eccSpanHasContent) {
        const iElem = eccSpan.querySelector('i');
        if (iElem && iElem.className) {
          // check whether the flag element indicates UN placeholder (class contains 'flag-sm-UN')
          const classes = iElem.className.split(/\s+/);
          if (classes.includes('flag-sm-UN') || classes.some(c => c === 'flag-sm-UN')) {
            eccSpanIsPlaceholderUN = true;
          }
        }
      }

      const hasEcc = eccSpanHasContent && !eccSpanIsPlaceholderUN && message.ecc !== undefined && message.ecc !== null && message.ecc !== "";

      if (!hasEcc) {
        // No ECC → small "No ECC" badge
        const noEcc = document.createElement('span');
        noEcc.textContent = 'ECC';
        noEcc.style.color = '#696969';
        noEcc.style.fontSize = '13px';
        noEcc.style.fontWeight = 'bold';
        noEcc.style.border = "1px solid #696969";
        noEcc.style.borderRadius = "3px";
        noEcc.style.padding = "0 2px";
        noEcc.style.lineHeight = "1.2";
        eccWrapper.appendChild(noEcc);
      } else {
        // ECC present → try to reuse existing ECC flag (if available)
        if (eccSpan && eccSpan.innerHTML.trim() !== "") {
          eccWrapper.appendChild(eccSpan.cloneNode(true));
        } else {
          // Fallback: simple grey "ECC"
          logInfo("No usable .data-flag found or it's empty → showing fallback 'ECC'.");
          const noEcc = document.createElement('span');
          noEcc.textContent = 'ECC';
          noEcc.style.color = '#696969';
          noEcc.style.fontSize = '13px';
          eccWrapper.appendChild(noEcc);
        }
      }
    }

    // --- RDS ---
    // Accept either boolean true or numeric 1 for "on"
    if (message.rds !== undefined) {
      const rdsIcon = document.getElementById('rdsIcon');
      const rdsOn = (message.rds === true || message.rds === 1);

      // Update MetricsMeters logic (RDS Meter)
      if (window.MetricsMeters && typeof window.MetricsMeters.setRdsStatus === 'function') {
        window.MetricsMeters.setRdsStatus(rdsOn);
      }

      if (rdsOn) {
        if (prevRdsState === false) {
          // bump meter on change to "on"
          levels.rds = Math.floor(Math.random() * (40 - 10 + 1)) + 10;
        }
        setIconSrc(rdsIcon, '/js/plugins/MetricsMonitor/images/rds_on.png');
      } else {
        levels.rds = 3;
        setIconSrc(rdsIcon, '/js/plugins/MetricsMonitor/images/rds_off.png');
      }
      prevRdsState = rdsOn;
      updateMeter('rds-meter', levels.rds);
    }

    // --- TP ---
    if (message.tp !== undefined) {
      const tpIcon = document.getElementById('tpIcon');
      const tpOn = (message.tp === 1 || message.tp === true);
      if (tpIcon) {
        setIconSrc(tpIcon, tpOn ? '/js/plugins/MetricsMonitor/images/tp_on.png' : '/js/plugins/MetricsMonitor/images/tp_off.png');
      }
    }

    // --- TA ---
    if (message.ta !== undefined) {
      const taIcon = document.getElementById('taIcon');
      const taOn = (message.ta === 1 || message.ta === true);
      if (taIcon) {
        setIconSrc(taIcon, taOn ? '/js/plugins/MetricsMonitor/images/ta_on.png' : '/js/plugins/MetricsMonitor/images/ta_off.png');
      }
    }
  }

  /**
   * Build and attach the header UI (ECC badge, stereo/mono, PTY label,
   * TP/TA/RDS icons) into the given `iconsBar` container.
   */
  function initHeader(iconsBar) {

    // --- Group: ECC badge + Stereo symbol + PTY label ---
    const leftGroup = document.createElement('div');
    leftGroup.style.display = 'flex';
    leftGroup.style.alignItems = 'center';
    leftGroup.style.gap = '10px';
    iconsBar.appendChild(leftGroup);

    // --- ECC wrapper ---
    const eccWrapper = document.createElement('span');
    eccWrapper.id = 'eccWrapper';
    eccWrapper.style.display = 'inline-flex';
    eccWrapper.style.alignItems = 'center';
    eccWrapper.style.whiteSpace = 'nowrap';
    leftGroup.appendChild(eccWrapper);

    // Try to clone an existing ECC flag from TEF Logger UI, otherwise show "ECC"
    const eccSpan = document.querySelector('.data-flag');
    
    // Decide whether eccSpan is usable or a UN placeholder:
    const eccSpanHasContent = eccSpan && eccSpan.innerHTML && eccSpan.innerHTML.trim() !== "";
    let eccSpanIsPlaceholderUN = false;
    if (eccSpanHasContent) {
      const iElem = eccSpan.querySelector('i');
      if (iElem && iElem.className) {
        const classes = iElem.className.split(/\s+/);
        if (classes.includes('flag-sm-UN') || classes.some(c => c === 'flag-sm-UN')) {
          eccSpanIsPlaceholderUN = true;
        }
      }
    }

    if (eccSpanHasContent && !eccSpanIsPlaceholderUN) {
      logInfo("initHeader: cloning existing .data-flag into eccWrapper.");
      eccWrapper.appendChild(eccSpan.cloneNode(true));
    } else {
      logInfo("initHeader: no usable .data-flag found or it's placeholder UN → adding placeholder 'ECC'.");
      const noEcc = document.createElement('span');
      noEcc.textContent = 'ECC';
      noEcc.style.color = '#696969';
      noEcc.style.fontSize = '13px';
      eccWrapper.appendChild(noEcc);
    }

    // --- Stereo Icon (Image) ---
    const stereoImg = document.createElement('img');
    stereoImg.className = 'status-icon';
    stereoImg.id = 'stereoIcon';
    stereoImg.alt = 'Stereo';
    
    // Enable interaction
    stereoImg.style.cursor = 'pointer';
    stereoImg.style.pointerEvents = 'auto'; 

    // Click Handler:
    stereoImg.addEventListener('click', () => {
        // Prevent action if Locked (B2 received), unless MPXStereoDecoder is on (where B2 is a valid toggle state)
        // or MPXmode is off (where locking logic should not apply)
        if (isClickLocked && MPXStereoDecoder !== "on" && MPXmode !== "off") {
            logInfo("Stereo icon click ignored: Button is locked via B2.");
            return;
        }

        if (TextSocket && TextSocket.readyState === WebSocket.OPEN) {

            // NEU: Verhalten abhängig von MPXStereoDecoder
            if (MPXStereoDecoder === "on") {
                // b2Active = true  → Wir sind im Stereo-Modus (da B2 den Stereo-Modus definiert)
                // b2Active = false → Wir sind im Mono-Modus (Standard)

                if (b2Active) {
                    // Wir sind Stereo -> Umschaltung auf Mono
                    TextSocket.send("B1");
                    TextSocket.send("L0");
                    logInfo('Stereo icon clicked (MPXStereoDecoder=on, Switching to Mono). Sending commands: B1 + L0');
                } else {
                    // Wir sind Mono -> Umschaltung auf Stereo
                    TextSocket.send("B2");
                    TextSocket.send("L1");
                    logInfo('Stereo icon clicked (MPXStereoDecoder=on, Switching to Stereo). Sending commands: B2 + L1');
                }

            } else {
                // MPXStereoDecoder = "off" → altes Verhalten beibehalten
                const cmd = currentIsForced ? "B0" : "B1";
                TextSocket.send(cmd);
                logInfo(`Stereo icon clicked. Sending command: ${cmd}`);
            }

        } else {
            logError("Cannot send command, WebSocket is not open.");
        }
    });

    // Initialize with default (stereo_off) or wait for first socket message
    setIconSrc(stereoImg, '/js/plugins/MetricsMonitor/images/stereo_off.png');
    leftGroup.appendChild(stereoImg);

    // --- PTY label placeholder ---
    const ptyLabel = document.createElement('span');
    ptyLabel.id = 'ptyLabel';
    ptyLabel.textContent = 'PTY';
    ptyLabel.style.color = '#696969';
    ptyLabel.style.fontSize = '13px';
    ptyLabel.style.width = '100px';
    leftGroup.appendChild(ptyLabel);

    // --- TP / TA / RDS PNG icons ---
    const iconMap = [
      { id: 'tpIcon',  off: '/js/plugins/MetricsMonitor/images/tp_off.png' },
      { id: 'taIcon',  off: '/js/plugins/MetricsMonitor/images/ta_off.png' },
      { id: 'rdsIcon', off: '/js/plugins/MetricsMonitor/images/rds_off.png' }
    ];
    iconMap.forEach(({ id, off }) => {
      const img = document.createElement('img');
      img.className = 'status-icon';
      img.id = id;
      img.alt = id;
      setIconSrc(img, off);
      iconsBar.appendChild(img);
    });

    // Start WebSocket for text/status data
    setupTextSocket();
  }

  /**
   * Initialize the WebSocket used for text / status messages.
   * Reconnects automatically on close.
   * → uses window.socketPromise
   */
  async function setupTextSocket() {
    if (TextSocket && TextSocket.readyState !== WebSocket.CLOSED) return;

    try {
      // window.socketPromise is provided by the main webserver code
      TextSocket = await window.socketPromise;

      TextSocket.addEventListener("open", () => {
        logInfo("WebSocket connected.");
      });

      TextSocket.addEventListener("message", (evt) => {
        try {
          const data = JSON.parse(evt.data);
          handleTextSocketMessage(data);
        } catch (err) {
          logError("Error parsing TextSocket message:", err);
        }
      });

      TextSocket.addEventListener("error", (err) => {
        logError("TextSocket error:", err);
      });

      TextSocket.addEventListener("close", () => {
        logInfo("TextSocket closed.");
        // Try to reconnect after a short delay
        setTimeout(setupTextSocket, 5000);
      });
    } catch (error) {
      logError("Failed to setup TextSocket:", error);
      // Retry on failure as well
      setTimeout(setupTextSocket, 5000);
    }
  }

  /**
   * Build and attach the header UI (ECC badge, stereo/mono, PTY label,
   * TP/TA/RDS icons) into the given `iconsBar` container.
   */
  function initHeader(iconsBar) {

    // --- Group: ECC badge + Stereo symbol + PTY label ---
    const leftGroup = document.createElement('div');
    leftGroup.style.display = 'flex';
    leftGroup.style.alignItems = 'center';
    leftGroup.style.gap = '10px';
    iconsBar.appendChild(leftGroup);

    // --- ECC wrapper ---
    const eccWrapper = document.createElement('span');
    eccWrapper.id = 'eccWrapper';
    eccWrapper.style.display = 'inline-flex';
    eccWrapper.style.alignItems = 'center';
    eccWrapper.style.whiteSpace = 'nowrap';
    leftGroup.appendChild(eccWrapper);

    // Try to clone an existing ECC flag from TEF Logger UI, otherwise show "ECC"
    const eccSpan = document.querySelector('.data-flag');
    
    // Decide whether eccSpan is usable or a UN placeholder:
    const eccSpanHasContent = eccSpan && eccSpan.innerHTML && eccSpan.innerHTML.trim() !== "";
    let eccSpanIsPlaceholderUN = false;
    if (eccSpanHasContent) {
      const iElem = eccSpan.querySelector('i');
      if (iElem && iElem.className) {
        const classes = iElem.className.split(/\s+/);
        if (classes.includes('flag-sm-UN') || classes.some(c => c === 'flag-sm-UN')) {
          eccSpanIsPlaceholderUN = true;
        }
      }
    }

    if (eccSpanHasContent && !eccSpanIsPlaceholderUN) {
      logInfo("initHeader: cloning existing .data-flag into eccWrapper.");
      eccWrapper.appendChild(eccSpan.cloneNode(true));
    } else {
      logInfo("initHeader: no usable .data-flag found or it's placeholder UN → adding placeholder 'ECC'.");
      const noEcc = document.createElement('span');
      noEcc.textContent = 'ECC';
      noEcc.style.color = '#696969';
      noEcc.style.fontSize = '13px';
      eccWrapper.appendChild(noEcc);
    }

    // --- Stereo Icon (Image) ---
    const stereoImg = document.createElement('img');
    stereoImg.className = 'status-icon';
    stereoImg.id = 'stereoIcon';
    stereoImg.alt = 'Stereo';
    
    // Enable interaction
    stereoImg.style.cursor = 'pointer';
    stereoImg.style.pointerEvents = 'auto'; 

// Click Handler:
stereoImg.addEventListener('click', () => {
    // Prevent action if Locked (B2 received), unless MPXStereoDecoder is on (where B2 is a valid toggle state)
    // or MPXmode is off (where locking logic should not apply)
    if (isClickLocked && MPXStereoDecoder !== "on" && MPXmode !== "off") {
        logInfo("Stereo icon click ignored: Button is locked via B2.");
        return;
    }

    if (TextSocket && TextSocket.readyState === WebSocket.OPEN) {

        // NEU: Verhalten abhängig von MPXStereoDecoder
        if (MPXStereoDecoder === "on") {
            // Wir nutzen b2Active als lokalen Toggle-Status.
            // b2Active == true  -> Wir haben zuletzt B2 (Stereo) gesendet -> Nächster Klick: Mono
            // b2Active == false -> Wir haben zuletzt B1 (Mono) gesendet   -> Nächster Klick: Stereo

            if (b2Active) {
                // Aktuell Stereo (B2) -> Umschaltung auf Mono
                TextSocket.send("B1");
                TextSocket.send("L0");
                
                // Status sofort manuell aktualisieren, damit der Toggle beim nächsten Klick funktioniert
                b2Active = false; 
                isClickLocked = false;

                logInfo('Stereo icon clicked (MPXStereoDecoder=on, State: Stereo -> Switching to Mono). Sent: B1 + L0');
            } else {
                // Aktuell Mono (B1) -> Umschaltung auf Stereo
                TextSocket.send("B2");
                TextSocket.send("L1");

                // Status sofort manuell aktualisieren
                b2Active = true;
                isClickLocked = true;

                logInfo('Stereo icon clicked (MPXStereoDecoder=on, State: Mono -> Switching to Stereo). Sent: B2 + L1');
            }

        } else {
            // MPXStereoDecoder = "off" → altes Verhalten beibehalten
            const cmd = currentIsForced ? "B0" : "B1";
            TextSocket.send(cmd);
            logInfo(`Stereo icon clicked. Sending command: ${cmd}`);
        }

    } else {
        logError("Cannot send command, WebSocket is not open.");
    }
});


    // Initialize with default (stereo_off) or wait for first socket message
    setIconSrc(stereoImg, '/js/plugins/MetricsMonitor/images/stereo_off.png');
    leftGroup.appendChild(stereoImg);

    // --- PTY label placeholder ---
    const ptyLabel = document.createElement('span');
    ptyLabel.id = 'ptyLabel';
    ptyLabel.textContent = 'PTY';
    ptyLabel.style.color = '#696969';
    ptyLabel.style.fontSize = '13px';
    ptyLabel.style.width = '100px';
    leftGroup.appendChild(ptyLabel);

    // --- TP / TA / RDS PNG icons ---
    const iconMap = [
      { id: 'tpIcon',  off: '/js/plugins/MetricsMonitor/images/tp_off.png' },
      { id: 'taIcon',  off: '/js/plugins/MetricsMonitor/images/ta_off.png' },
      { id: 'rdsIcon', off: '/js/plugins/MetricsMonitor/images/rds_off.png' }
    ];
    iconMap.forEach(({ id, off }) => {
      const img = document.createElement('img');
      img.className = 'status-icon';
      img.id = id;
      img.alt = id;
      setIconSrc(img, off);
      iconsBar.appendChild(img);
    });

    // Start WebSocket for text/status data
    setupTextSocket();
  }

  // Expose functions for the main plugin code
  window.MetricsHeader = {
    initHeader,
    setMonoLockFromMode
  };
})();