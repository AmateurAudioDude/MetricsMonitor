///////////////////////////////////////////////////////////////
/// Upper Section: Stereo / ECC / PTY / TA / TP / RDS       ///
///////////////////////////////////////////////////////////////

(() => {
const sampleRate = 48000;    // Do not touch - this value is automatically updated via the config file
const stereoBoost = 1;    // Do not touch - this value is automatically updated via the config file
const eqBoost = 1;    // Do not touch - this value is automatically updated via the config file
const fftSize = 512;    // Do not touch - this value is automatically updated via the config file
const SpectrumAverageLevel = 30;    // Do not touch - this value is automatically updated via the config file
const minSendIntervalMs = 15;    // Do not touch - this value is automatically updated via the config file
const MPXmode = "off";    // Do not touch - this value is automatically updated via the config file

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
  // When true, L1 is active → force mono display
  let forcedMonoByL1 = false;
  
  let lastForcedState  = null;     // null | true | false
  let lastVisibleState = null;     // "mono" | "stereo" | "locked"

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

  // ---------------------------------------------------------
  // Stereo/Mono circle symbol helpers
  // ---------------------------------------------------------

  function getStereoIcon() {
    return document.getElementById('stereoIcon');
  }

  function getStereoCircles() {
    const icon = getStereoIcon();
    if (!icon) return { c1: null, c2: null };

    const c1 = icon.querySelector('.circle1');
    const c2 = icon.querySelector('.circle2');
    return { c1, c2 };
  }

  // Reset only style properties that this script may touch
  function resetIconStyle(icon) {
    if (!icon) return;
    icon.style.opacity       = '';
    icon.style.filter        = '';
    icon.style.pointerEvents = '';
    icon.style.cursor        = '';
    icon.style.marginLeft    = '';
	icon.style.marginRight   = '';
  }

  // Mono form: only circle1 visible, circle2 hidden
  function applyMonoCircles(dimForced) {
    const { c1, c2 } = getStereoCircles();
    if (c1) {
      c1.style.opacity = '1';
      c1.style.display = '';
      c1.style.filter  = '';
	  c1.marginLeft    = '4px';
    }
    if (c2) {
      c2.style.opacity = '0';
      c2.style.display = 'none';
      c2.style.filter  = '';
    }
  }

  // Real stereo: both circles visible; icon style from CSS
  function showStereoSymbol() {
    const icon = getStereoIcon();
    const { c1, c2 } = getStereoCircles();
    if (!icon) return;

    resetIconStyle(icon);
    icon.classList.remove('stereo-mono');

    if (c1) {
      c1.style.opacity = '';
      c1.style.filter  = '';
      c1.style.display = '';
    }
    if (c2) {
      c2.style.opacity = '';
      c2.style.filter  = '';
      c2.style.display = '';
    }
  }

  // Mono:
  //  • L0 (dimForced=false)
  //  • L1 (dimForced=true)
  function showMonoSymbol(dimForced) {
    const icon = getStereoIcon();
    if (!icon) return;

    icon.classList.add('stereo-mono');

    if (dimForced) {
      // Forced mono (L1)
      icon.style.opacity       = '1';
      icon.style.pointerEvents = 'none';
      icon.style.cursor        = 'default';
	  if (prevStereoState) {
		icon.style.marginLeft    = '8px';
		icon.style.marginRight    = '-4px';
	  } else {
		icon.style.marginLeft    = '4px';
		icon.style.marginRight    = '0px';
	  }
    } else {
      // Real mono (L0)
      resetIconStyle(icon);
    }

    applyMonoCircles(dimForced);
  }

function applyForcedMonoDisplay() {
  showMonoSymbol(true);

  // Log only once when switching to locked mono
  if (lastVisibleState !== "locked") {
    logInfo("Stereo header indicator forced to MONO (L1 active).");
    lastVisibleState = "locked";
  }
}

function applyRealStereoDisplayFromPrev() {
  const icon = getStereoIcon();
  resetIconStyle(icon);

  if (prevStereoState) {
    showStereoSymbol();
    if (lastVisibleState !== "stereo") {
      logInfo("Stereo header indicator restored to STEREO (L0, real signal).");
      lastVisibleState = "stereo";
    }
  } else {
    showMonoSymbol(false);
    if (lastVisibleState !== "mono") {
      logInfo("Stereo header indicator restored to MONO (L0, real signal).");
      lastVisibleState = "mono";
    }
  }
}


function setMonoLockFromMode(cmdRaw) {
  const cmd = String(cmdRaw).trim().toUpperCase();

  if (cmd === "L1") {
    forcedMonoByL1 = true;
    if (lastForcedState !== true) {
      logInfo('L1 from client – forcing stereo indicator to MONO.');
      lastForcedState = true;
    }
    applyForcedMonoDisplay();
  }
  else if (cmd === "L0") {
    const wasLocked = forcedMonoByL1;
    forcedMonoByL1 = false;

    if (lastForcedState !== false) {
      logInfo('L0 from client – restoring stereo indicator to real mono/stereo state.');
      lastForcedState = false;
    }

    if (wasLocked) {
      applyRealStereoDisplayFromPrev();
    }
  }
}


  /**
   * Handle incoming JSON messages from the WebSocket
   * and update meters / icons / labels in the header.
   */
  function handleTextSocketMessage(message) {
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

if (message.st !== undefined) {
  const isStereo = (message.st === true || message.st === 1);

  prevStereoState = isStereo;

  if (forcedMonoByL1) {
    // No logs here → forced state handled above
    applyForcedMonoDisplay();
  } else {
    if (isStereo) {
      showStereoSymbol();
      lastVisibleState = "stereo";
    } else {
      showMonoSymbol(false);
      lastVisibleState = "mono";
    }
  }
}


    // --- ECC (Extended Country Code) badge ---
    const eccWrapper = document.getElementById('eccWrapper');
    if (eccWrapper) {
      // Clear previous content each update
      eccWrapper.innerHTML = "";

      const hasEcc = message.ecc !== undefined && message.ecc !== null && message.ecc !== "";

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
        const eccSpan = document.querySelector('.data-flag');
        if (eccSpan && eccSpan.innerHTML.trim() !== "") {
          eccWrapper.appendChild(eccSpan.cloneNode(true));
        } else {
          // Fallback: simple grey "ECC"
          const noEcc = document.createElement('span');
          noEcc.textContent = 'ECC';
          noEcc.style.color = '#696969';
          noEcc.style.fontSize = '13px';
          eccWrapper.appendChild(noEcc);
        }
      }
    }
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
    if (eccSpan && eccSpan.innerHTML.trim() !== "") {
      eccWrapper.appendChild(eccSpan.cloneNode(true));
    } else {
      const noEcc = document.createElement('span');
      noEcc.textContent = 'ECC';
      noEcc.style.color = '#696969';
      noEcc.style.fontSize = '13px';
      eccWrapper.appendChild(noEcc);
    }

    // --- Stereo circle symbol cloned from .stereo-container ---
    const stereoSource = document.querySelector('.stereo-container');
    if (stereoSource) {
      const stereoClone = stereoSource.cloneNode(true);
      stereoClone.id = 'stereoIcon';
      stereoClone.removeAttribute('style');  // use our own layout
      stereoClone.classList.add("tooltip");
      stereoClone.setAttribute("data-tooltip", "Stereo / Mono indicator. Click to toggle.");
      stereoClone.style.marginLeft = '0px';
      stereoClone.style.cursor     = 'default'; // indicator only, no toggle
      leftGroup.appendChild(stereoClone);

      // Initial look: treat as mono until first st value comes in
      showMonoSymbol(false);
    }

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
