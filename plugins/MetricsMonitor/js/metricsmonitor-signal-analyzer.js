///////////////////////////////////////////////////////////////
//      METRICS MONITOR — SIGNAL ANALYZER MODULE             //
///////////////////////////////////////////////////////////////

const originalOnError = window.onerror;
window.onerror = function(message, source, lineno, colno, error) {
  const msg = typeof message === 'string' ? message : '';

  const knownErrors = [
    "Cannot read properties of undefined (reading 'getDatasetMeta')",
    "Cannot set properties of null (setting '_setStyle')"
  ];

  const isKnownError = knownErrors.some(knownError => msg.includes(knownError));

  if (isKnownError) {
    return true; 
  }
  
  if (originalOnError) {
    return originalOnError.apply(this, arguments);
  }
  
  return false;
};

(() => {
  // --- Global State ---
  
  let socket = null;
  let isSocketConnected = false;

  // Global Chart Instance
  let signalChart = null;
  
  // Persistent Data Storage
  let storedSignalData = [];

  // State for Frequency Change Detection
  let lastFreq = null;
  let lastLabelTime = 0;

  // Zoom / Pan State
  let isDragging = false;
  let hasDragged = false; 
  let lastY = 0;
  
  // Tooltip and Keyboard State
  let tooltipElement = null;
  let ctrlKeyPressed = false;
  let ctrlKeyWasPressed = false;
  
  // Default Configuration (Base Unit: dBf)
  const Y_MIN_DEFAULT_BASE = 0;
  const Y_MAX_DEFAULT_BASE = 100;
  const DURATION_DEFAULT = 20000;

  // Current Measurement Unit
  let currentUnit = "dbf"; // default

  // Unit Configuration
  const UNIT_CONFIG = {
    dbf: { label: "dBf" },
    dbuv: { label: "dBµV" },
    dbm: { label: "dBm" }
  };

  // --- Persistent View State ---
  // Stores limits in DISPLAY UNITS to simplify logic
  let currentZoomState = {
      yMin: Y_MIN_DEFAULT_BASE,
      yMax: Y_MAX_DEFAULT_BASE,
      duration: DURATION_DEFAULT,
      lastUnit: "dbf" 
  };
  
  // --- Helper: Conversion Logic ---
  function convertValue(baseValue, targetUnit) {
      const ssu = (targetUnit || "").toLowerCase();
      const v = Number(baseValue);
      if (!isFinite(v)) return 0;
      
      if (ssu === "dbuv" || ssu === "dbµv" || ssu === "dbμv") return v - 10.875;
      if (ssu === "dbm") return v - 119.75;
      
      // Default: dBf (no change)
      return v;
  }

  // --- Helper: Reverse Conversion Logic ---
  function convertValueInverse(displayValue, sourceUnit) {
      const ssu = (sourceUnit || "").toLowerCase();
      const v = Number(displayValue);
      if (!isFinite(v)) return 0;

      if (ssu === "dbuv" || ssu === "dbµv" || ssu === "dbμv") return v + 10.875;
      if (ssu === "dbm") return v + 119.75;
      
      return v;
  }

  // --- Helper: Update cursor style based on zoom state ---
  function updateCursorStyle(canvas) {
      if (!signalChart || !canvas) return;
      const yAxis = signalChart.options.scales.y;
      
      // Compare current axis limits to default limits for CURRENT unit
      const defaultMin = convertValue(Y_MIN_DEFAULT_BASE, currentUnit);
      const defaultMax = convertValue(Y_MAX_DEFAULT_BASE, currentUnit);
      
      // Allow small float tolerance
      const isVerticallyZoomed = Math.abs(yAxis.min - defaultMin) > 0.5 || Math.abs(yAxis.max - defaultMax) > 0.5;

      if (ctrlKeyPressed) {
          canvas.style.cursor = "help"; 
      } else if (isDragging) {
          canvas.style.cursor = "grabbing";
      } else if (isVerticallyZoomed) {
          canvas.style.cursor = "ns-resize"; 
      } else {
          canvas.style.cursor = "pointer"; 
      }
  }

  // --- Tooltip Functions ---
  function showTooltip() {
      if (tooltipElement || !signalChart) return;
      const canvas = signalChart.canvas;
      
      tooltipElement = document.createElement("div");
      tooltipElement.id = "signal-zoom-tooltip";
      tooltipElement.innerHTML = `
        <div style="margin-bottom: 8px; font-weight: bold;">Signal Chart Zoom Controls</div>
        <div style="margin-bottom: 4px;">• Scroll wheel  Horizontal zoom (time)</div>
        <div style="margin-bottom: 4px;">• Ctrl + Scroll wheel  Vertical zoom (level)</div>
        <div style="margin-bottom: 4px;">• Left-click + Drag  Pan vertically</div>
        <div style="margin-bottom: 4px;">• Right-click  Reset zoom</div>
        <div style="margin-top: 5px; border-top: 1px solid rgba(143, 234, 255, 0.2); padding-top: 5px;"></div>
        <div style="margin-bottom: 4px;">• Ctrl + ↑ / ↓  Vertical zoom in/out</div>
        <div style="margin-bottom: 4px;">• Ctrl + ← / →  Horizontal zoom in/out</div>
        <div style="margin-bottom: 4px;">• Ctrl + Space  Reset zoom</div>
      `;
      
      tooltipElement.style.cssText = `
        position: absolute; background: linear-gradient(to bottom, rgba(0, 40, 70, 0.95), rgba(0, 25, 50, 0.95));
        border: 1px solid rgba(143, 234, 255, 0.5); border-radius: 8px; padding: 12px 16px; color: #8feaff;
        font-family: Arial, sans-serif; font-size: 10px; line-height: 1.2; z-index: 10000; pointer-events: none;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); opacity: 0; transition: opacity 0.2s ease-in-out;
        max-width: 320px; white-space: nowrap;
      `;
      
      const parent = canvas.parentElement;
      if (!parent) return;
      parent.style.position = "relative";
      parent.appendChild(tooltipElement);
      
      const tooltipWidth = tooltipElement.offsetWidth;
      const tooltipHeight = tooltipElement.offsetHeight;
      const tooltipLeft = (canvas.width - tooltipWidth) / 2;
      const tooltipTop = (canvas.height - tooltipHeight) / 2;

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
      if (tooltipElement && tooltipElement.parentElement) {
        tooltipElement.parentElement.removeChild(tooltipElement);
      }
      tooltipElement = null;
    }, 200);
  }

  /////////////////////////////////////////////////////////////////
  // Data Handling
  /////////////////////////////////////////////////////////////////
  function updateSignal(value, freq) {
    let rawVal = parseFloat(value);
    if (isNaN(rawVal) || !isFinite(rawVal)) return;
    
    const now = Date.now();
    const point = { x: now, y: rawVal };
    
    if (freq !== undefined && freq !== null && freq !== "") {
      const currentFreqFormatted = parseFloat(freq).toFixed(2);
      
      if (lastFreq !== currentFreqFormatted) {
        if (now - lastLabelTime > 3000) {
          point.freqChange = currentFreqFormatted;
          lastFreq = currentFreqFormatted;
          lastLabelTime = now;
        }
      }
    }

    storedSignalData.push(point);
    
    if (storedSignalData.length > 10000) storedSignalData.shift();

    if (signalChart) {
      signalChart.update('quiet');
    }
  }

  async function connectToDataStream() {
    if (isSocketConnected) return;
    try {
      if (window.socketPromise) {
        socket = await window.socketPromise;
        if (socket) {
          socket.addEventListener("message", (evt) => {
            try {
              const msg = JSON.parse(evt.data);
              if (msg && msg.sig !== undefined) updateSignal(msg.sig, msg.freq);
            } catch {}
          });
          isSocketConnected = true;
        }
      } else {
        setTimeout(connectToDataStream, 1000);
      }
    } catch {}
  }
  
  /////////////////////////////////////////////////////////////////
  // Unit Change Handler
  /////////////////////////////////////////////////////////////////
  function handleUnitChange(newUnit) {
      if (!newUnit || newUnit === currentUnit) return;
      
      const oldUnit = currentUnit;
      currentUnit = newUnit.toLowerCase();
      
      // Save current view state relative to OLD unit
      if (signalChart) {
         currentZoomState.yMin = convertValue(signalChart.options.scales.y.min, oldUnit);
         currentZoomState.yMax = convertValue(signalChart.options.scales.y.max, oldUnit);
         currentZoomState.duration = signalChart.options.scales.x.realtime.duration;
      }

      // Convert stored limits from OLD to NEW unit to keep view consistent
      // Note: currentZoomState stores DISPLAY values now for easier logic
      const minBase = convertValueInverse(currentZoomState.yMin, oldUnit);
      const maxBase = convertValueInverse(currentZoomState.yMax, oldUnit);
      
      currentZoomState.yMin = convertValue(minBase, currentUnit);
      currentZoomState.yMax = convertValue(maxBase, currentUnit);
      currentZoomState.lastUnit = currentUnit;

      // Re-init to rebuild scales cleanly
      init();
  }

  /////////////////////////////////////////////////////////////////
  // Public API / Initialization
  /////////////////////////////////////////////////////////////////
  function init(containerId = "level-meter-container") {
    const parent = document.getElementById(containerId);
    if (!parent) return;

    if (signalChart) signalChart.destroy();
    signalChart = null;
    
    parent.innerHTML = "";

    // --- STATE RESTORATION ---
    // If first run, set defaults based on DEFAULT BASE (dBf) converted to current unit
    // This ensures that if we start in dBm, we start with -120 to -20 range, not 0-100.
    if (storedSignalData.length === 0) {
        lastFreq = null;
        lastLabelTime = 0;
        
        currentZoomState.yMin = convertValue(Y_MIN_DEFAULT_BASE, currentUnit);
        currentZoomState.yMax = convertValue(Y_MAX_DEFAULT_BASE, currentUnit);
        currentZoomState.duration = DURATION_DEFAULT;
        currentZoomState.lastUnit = currentUnit; // Sync immediately
    }

    tooltipElement = null;
    ctrlKeyPressed = false;
    ctrlKeyWasPressed = false;

    // Detect Initial Unit
    if (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === "function") {
        let u = window.MetricsMonitor.getSignalUnit();
        if (u) {
             const newU = u.toLowerCase();
             // If unit changed during reload/init detection
             if (newU !== currentUnit) {
                 // Convert existing defaults to new unit
                 const minBase = convertValueInverse(currentZoomState.yMin, currentUnit);
                 const maxBase = convertValueInverse(currentZoomState.yMax, currentUnit);
                 currentUnit = newU;
                 currentZoomState.yMin = convertValue(minBase, currentUnit);
                 currentZoomState.yMax = convertValue(maxBase, currentUnit);
             }
        }
    }
    
    // Ensure state tracks current unit
    currentZoomState.lastUnit = currentUnit;

    // Subscribe to Unit Changes
    if (window.MetricsMonitor && typeof window.MetricsMonitor.onSignalUnitChange === "function") {
        window.MetricsMonitor.onSignalUnitChange(handleUnitChange);
    }

    const wrap = document.createElement("div");
    wrap.id = "signalCanvasContainer";
    wrap.style.cssText = "position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none;";
    
    const canvas = document.createElement("canvas");
    canvas.id = "signalCanvas";
    canvas.style.cssText = "display: block; width: 100%; height: 100%; background: linear-gradient(to bottom, #001225 0%, #002044 100%);";
    
    wrap.appendChild(canvas);
    parent.appendChild(wrap);

    const ctx = canvas.getContext("2d");

    if (typeof Chart === 'undefined') return console.error("Chart.js is not loaded.");
    
    // --- Plugins ---
    const freqLabelPlugin = {
      id: 'freqLabelRenderer',
      afterDatasetsDraw(chart) {
        if (!chart || !chart.data || !chart.data.datasets || !chart.data.datasets.length) return;
        const meta = chart.getDatasetMeta(0);
        if (!meta) return;
        const { ctx, chartArea } = chart;
        const dataset = chart.data.datasets[0];
        
        ctx.save();
        ctx.beginPath();
        
        meta.data.forEach((element, index) => {
          const dataPoint = dataset.data[index];
          if (dataPoint && dataPoint.freqChange) {
             const model = element;
             if (!model || model.x < chartArea.left || model.x > chartArea.right) return;

             let yLineStart, yLineEnd;
             if (model.y < chartArea.top + 20) { 
                yLineStart = Math.max(model.y + 2, chartArea.top); 
                yLineEnd = Math.max(model.y + 10, chartArea.top + 8);
             } else { 
                yLineStart = model.y - 2;
                yLineEnd = model.y - 10;
             }
             
             ctx.beginPath();
             ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
             ctx.lineWidth = 1;
             ctx.moveTo(model.x, yLineStart);
             ctx.lineTo(model.x, yLineEnd);
             ctx.stroke();

             ctx.font = "bold 12px Arial";
             ctx.fillStyle = "#ffffff"; 
             ctx.textAlign = "center";

             let yPos, textBaseline;
             if (model.y < chartArea.top + 30) { 
                 textBaseline = "bottom";
                 yPos = Math.max(chartArea.top - 2, model.y - 5);
             } else { 
                 textBaseline = "bottom";
                 yPos = model.y - 12;
             }
             
             ctx.textBaseline = textBaseline;
             ctx.fillText(dataPoint.freqChange, model.x, yPos);
          }
        });
        ctx.restore();
      }
    };

    const unitLabelPlugin = {
      id: 'unitLabelRenderer',
      afterDraw(chart) {
        const { ctx, scales } = chart;
        const yAxis = scales.y;
        ctx.save();
        ctx.font = "11px Arial";
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)"; 
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        const yPos = yAxis.bottom + 6; 
        
        let xPos;
        if (currentUnit === 'dbuv' || currentUnit === 'dBµV') {
            xPos = yAxis.right + 2; 
        } else {
            xPos = yAxis.right - 4; 
        }

        const config = UNIT_CONFIG[currentUnit];
        if (config && config.label) {
            ctx.fillText(config.label, xPos, yPos);
        }
        ctx.restore();
      }
    };

    const currentValuePlugin = {
        id: 'currentValueRenderer',
        afterDatasetsDraw(chart) {
            if (!chart || !chart.data || !chart.data.datasets || !chart.data.datasets.length) return;
            const meta = chart.getDatasetMeta(0);
            if (!meta || !meta.data || !meta.data.length) return;
            const { ctx, chartArea } = chart;
            const dataset = chart.data.datasets[0];
            
            const lastDataPoint = dataset.data[dataset.data.length - 1];
            const lastElement = meta.data[meta.data.length - 1];
            
            if (!lastDataPoint || !lastElement) return;
            const { x, y } = lastElement;

            if (x < chartArea.left || x > chartArea.right || y < chartArea.top || y > chartArea.bottom) return;
            
            const rawY = lastDataPoint.y;
            const displayY = convertValue(rawY, currentUnit);

            const text = displayY.toFixed(1);

            ctx.save();
            ctx.font = "bold 11px Arial";
            ctx.fillStyle = dataset.borderColor; 
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(text, x, y + 6);
            ctx.restore();
        }
    };
    
    // Use stored ZOOM state directly as min/max.
    // However, Chart.js expects RAW scale values (if using parsing).
    // BUT we are using a custom tick generator (afterBuildTicks) which essentially maps
    // raw values to display grids.
    // 
    // To make zooming work properly in dBm:
    // We should treat the scale values as RAW (dBf) values internally.
    // 1. Min/Max passed to scale are dBf.
    // 2. Zoom handlers calculate new Min/Max in dBf.
    // 3. Ticks are drawn by converting grid to dBf.
    //
    // The previous issue was likely that we were mixing units in the zoom state.
    
    // FIX: Convert ViewState (Display Units) -> Chart Config (Raw Units)
    const chartMin = convertValueInverse(currentZoomState.yMin, currentUnit);
    const chartMax = convertValueInverse(currentZoomState.yMax, currentUnit);

    signalChart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [ {
            label: 'Signal', 
            data: storedSignalData, 
            parsing: {
                yAxisKey: 'y', // Always read raw dBf
                xAxisKey: 'x'
            },
            borderWidth: 1, 
            pointRadius: 0, 
            tension: 0.15, 
            borderColor: '#8feaff',
            backgroundColor: 'rgba(143, 234, 255, 0.1)', 
            fill: true, 
            pointHoverRadius: 0, 
            pointHitRadius: 0,
        } ],
      },
      plugins: [freqLabelPlugin, unitLabelPlugin, currentValuePlugin], 
      options: {
        responsive: true, 
        maintainAspectRatio: false, 
        animation: false,
        layout: { padding: { top: 25, right: 5, bottom: 5, left: 0 } }, 
        interaction: { intersect: false, mode: 'nearest', },
        scales: {
          x: {
            type: 'realtime', 
            realtime: { 
                duration: currentZoomState.duration, 
                refresh: 100, 
                delay: 1000, 
                pause: false, 
            },
            grid: { display: true, color: 'rgba(255,255,255,0.05)', drawTicks: false },
            ticks: { display: true, color: 'rgba(255,255,255,0.5)', maxRotation: 0, autoSkip: true, maxTicksLimit: 15, padding: 5 },
          },
          y: {
            min: chartMin, 
            max: chartMax, 
            grace: 0,
            grid: { color: 'rgba(255,255,255,0.08)', drawTicks: false },
            ticks: {
              color: 'rgba(255,255,255,0.5)', font: { size: 11, family: "Arial" },
              autoSkip: false, includeBounds: false, padding: 8, 
              callback: function(value) {
                const displayVal = convertValue(value, currentUnit);
                const roundedVal = Math.round(displayVal);
                
                // --- CUSTOM HIDING RULES ---
                if (currentUnit === 'dbuv' || currentUnit === 'dBµV') {
                    if (roundedVal === -20) return null;
                    if (roundedVal === -10) return null; // Hide -10 also
                }
                
                if (currentUnit === 'dbf') {
                    if (roundedVal === 0 || roundedVal === 100) return null;
                }
                
                return roundedVal;
              }
            },
            afterBuildTicks: function(axis) {
                const minRaw = axis.min;
                const maxRaw = axis.max;
                
                // Convert current VIEW PORT to display units
                const minDisp = convertValue(minRaw, currentUnit);
                const maxDisp = convertValue(maxRaw, currentUnit);
                const range = maxDisp - minDisp;
                
                let step;
                if (range <= 10) step = 1;
                else if (range <= 25) step = 5;
                else step = 10;
                
                // Calculate Alignment
                let start = Math.ceil(minDisp / step) * step;
                if (start < minDisp) start += step;
                
                const newTicks = [];
                for (let v = start; v <= maxDisp + 0.0001; v += step) {
                    // Convert display grid value back to raw Y value for positioning
                    const rawVal = convertValueInverse(v, currentUnit);
                    newTicks.push({ value: rawVal });
                }
                axis.ticks = newTicks;
            },
            position: 'right'
          },
        },
        plugins: { legend: { display: false }, tooltip: { enabled: true, mode: 'index', intersect: false }, },
      },
    });

    setupCustomZoomHandlers(canvas);
    setupKeyboardControls(canvas);
    
    connectToDataStream();
    updateCursorStyle(canvas);
  }

  /////////////////////////////////////////////////////////////////
  // CUSTOM ZOOM, PAN & KEYBOARD HANDLERS
  /////////////////////////////////////////////////////////////////
  function updateStoredZoomState() {
      if (!signalChart) return;
      const scales = signalChart.options.scales;
      
      // Store state in DISPLAY units (user readable)
      currentZoomState.yMin = convertValue(scales.y.min, currentUnit);
      currentZoomState.yMax = convertValue(scales.y.max, currentUnit);
      currentZoomState.duration = scales.x.realtime.duration;
  }

  function setupKeyboardControls(canvas) {
    const H_ZOOM_FACTOR = 1.2;
    const V_ZOOM_FACTOR = 1.2;

    window.addEventListener("keydown", (e) => {
        if (!signalChart || (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
        
        if (e.key === "Control" && !ctrlKeyWasPressed) {
          ctrlKeyPressed = true;
          ctrlKeyWasPressed = true;
          if (!isDragging) {
            showTooltip();
            updateCursorStyle(canvas);
          }
        }
        
        if (!e.ctrlKey) return;

        let handled = false;
        const scales = signalChart.options.scales;

        switch (e.key) {
            case 'ArrowLeft': {
              const realtimeOpts = scales.x.realtime;
              let newDuration = realtimeOpts.duration / H_ZOOM_FACTOR;
              if (newDuration < 1000) newDuration = 1000;
              realtimeOpts.duration = newDuration;
              handled = true;
              break;
            }
            case 'ArrowRight': {
              const realtimeOpts = scales.x.realtime;
              let newDuration = realtimeOpts.duration * H_ZOOM_FACTOR;
              if (newDuration > 120000) newDuration = 120000;
              realtimeOpts.duration = newDuration;
              handled = true;
              break;
            }
            case 'ArrowUp': {
                const currentRange = scales.y.max - scales.y.min;
                let newRange = currentRange / V_ZOOM_FACTOR;
                if (newRange < 5) newRange = 5;
                const center = (scales.y.max + scales.y.min) / 2;
                scales.y.min = center - newRange / 2;
                scales.y.max = center + newRange / 2;
                handled = true;
                break;
            }
            case 'ArrowDown': {
                // Calculate limits based on CURRENT UNIT
                const minLimitRaw = convertValueInverse(convertValue(Y_MIN_DEFAULT_BASE, currentUnit), currentUnit);
                const maxLimitRaw = convertValueInverse(convertValue(Y_MAX_DEFAULT_BASE, currentUnit), currentUnit);
                // Note: The above is effectively just converting back and forth, 
                // but conceptually we want limits that match 0-100 dBf.
                const ABS_MIN_DBF = 0;
                const ABS_MAX_DBF = 100;
                
                const currentRange = scales.y.max - scales.y.min;
                let newRange = currentRange * V_ZOOM_FACTOR;
                if (newRange > (ABS_MAX_DBF - ABS_MIN_DBF)) newRange = ABS_MAX_DBF - ABS_MIN_DBF;
                
                const center = (scales.y.max + scales.y.min) / 2;
                let newMin = center - newRange / 2;
                let newMax = center + newRange / 2;
                
                if (newMin < ABS_MIN_DBF) {
                    newMin = ABS_MIN_DBF; newMax = newMin + newRange;
                }
                if (newMax > ABS_MAX_DBF) {
                    newMax = ABS_MAX_DBF; newMin = newMax - (newMax - newMin);
                }
                scales.y.min = newMin;
                scales.y.max = newMax;
                handled = true;
                break;
            }
            case ' ':
                zoomReset();
                handled = true;
                break;
        }

        if (handled) {
            e.preventDefault();
            e.stopPropagation();
            hideTooltip();
            signalChart.update('none');
            updateStoredZoomState();
            updateCursorStyle(canvas);
        }
    });

    window.addEventListener("keyup", (e) => {
        if (e.key === "Control") {
          ctrlKeyPressed = false;
          ctrlKeyWasPressed = false;
          hideTooltip();
          updateCursorStyle(canvas);
        }
    });
  }

  function setupCustomZoomHandlers(canvas) {
    canvas.addEventListener("wheel", (e) => {
      if (!signalChart) return;
      e.preventDefault();
      hideTooltip();
      const scales = signalChart.options.scales;
      const zoomFactor = e.deltaY < 0 ? 0.9 : 1.1; 

      if (e.ctrlKey) {
        // Limits: Always respect 0 to 100 dBf range internally
        const ABS_MIN_DBF = 0;
        const ABS_MAX_DBF = 100;

        const currentRange = scales.y.max - scales.y.min;
        let newRange = currentRange * zoomFactor;
        
        if (newRange > (ABS_MAX_DBF - ABS_MIN_DBF)) newRange = ABS_MAX_DBF - ABS_MIN_DBF;
        if (newRange < 5) newRange = 5;
        
        const center = (scales.y.max + scales.y.min) / 2;
        let newMin = center - (newRange / 2);
        let newMax = center + (newRange / 2);
        
        if (newMin < ABS_MIN_DBF) {
            newMin = ABS_MIN_DBF; newMax = newMin + newRange;
        }
        if (newMax > ABS_MAX_DBF) {
            newMax = ABS_MAX_DBF; newMin = newMax - newRange;
        }
        scales.y.min = newMin;
        scales.y.max = newMax;
      } else {
        const realtimeOpts = scales.x.realtime;
        let newDuration = realtimeOpts.duration * zoomFactor;
        
        if (newDuration < 1000) newDuration = 1000;
        if (newDuration > 120000) newDuration = 120000;
        realtimeOpts.duration = newDuration;
      }
      signalChart.update('none'); 
      updateStoredZoomState();
      updateCursorStyle(canvas);
    });

    canvas.addEventListener("mousedown", (e) => {
      // Logic relies on checking against defaults
      const yAxis = signalChart.options.scales.y;
      
      // Calculate defaults in RAW units
      const defMin = convertValueInverse(convertValue(Y_MIN_DEFAULT_BASE, currentUnit), currentUnit);
      const defMax = convertValueInverse(convertValue(Y_MAX_DEFAULT_BASE, currentUnit), currentUnit);
      // Effectively 0 and 100
      
      const isVerticallyZoomed = Math.abs(yAxis.min - defMin) > 0.5 || Math.abs(yAxis.max - defMax) > 0.5;
      
      if (!isVerticallyZoomed || e.button !== 0) return;
      
      hideTooltip();
      isDragging = true;
      hasDragged = false; 
      lastY = e.clientY;
      updateCursorStyle(canvas);
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging || !signalChart) return;
      const deltaY = e.clientY - lastY;
      
      if (Math.abs(deltaY) > 2) hasDragged = true; 
      if (!hasDragged) return;
      
      lastY = e.clientY;
      
      const scales = signalChart.options.scales;
      const range = scales.y.max - scales.y.min;
      const chartAreaHeight = signalChart.chartArea.bottom - signalChart.chartArea.top;
      
      if (chartAreaHeight <= 0) return;
      
      const valueDelta = (deltaY / chartAreaHeight) * range;
      
      let newMin = scales.y.min + valueDelta;
      let newMax = scales.y.max + valueDelta;
      
      const currentZoomRange = newMax - newMin;
      const ABS_MIN_DBF = 0;
      const ABS_MAX_DBF = 100;
      
      if (newMin < ABS_MIN_DBF) {
          newMin = ABS_MIN_DBF; newMax = newMin + currentZoomRange;
      }
      if (newMax > ABS_MAX_DBF) {
          newMax = ABS_MAX_DBF; newMin = newMax - currentZoomRange;
      }
      
      scales.y.min = newMin;
      scales.y.max = newMax;
      signalChart.update('none');
      updateStoredZoomState();
    });

    window.addEventListener("mouseup", (e) => {
      if (isDragging) {
        isDragging = false;
        updateCursorStyle(canvas);
        if (hasDragged) e.stopPropagation();
      }
    });
    
    canvas.addEventListener("click", (e) => {
        if (hasDragged) {
            e.stopPropagation();
            hasDragged = false;
        }
    }, true); 
    
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      hideTooltip();
      zoomReset();
    });
  }

  function zoomReset() {
    if (signalChart) {
      // Reset to 0-100 dBf (Raw)
      // This works for ALL units because the tick callback handles conversion
      const ABS_MIN_DBF = 0;
      const ABS_MAX_DBF = 100;
      
      signalChart.options.scales.y.min = ABS_MIN_DBF;
      signalChart.options.scales.y.max = ABS_MAX_DBF;
      signalChart.options.scales.x.realtime.duration = DURATION_DEFAULT;
      
      signalChart.update();
      updateStoredZoomState(); 
      updateCursorStyle(signalChart.canvas);
    }
  }

  window.MetricsSignalAnalyzer = {
    init,
    updateSignal,
    zoomReset,
  };

})();