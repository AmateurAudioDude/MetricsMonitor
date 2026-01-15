/*
 * MPXCapture.cs   High-Performance MPX Analyzer Tool (C# / NAudio)
 *
 * This version is aligned to the behavior of the updated MPXCapture.c:
 *  - Pilot measurement: 19 kHz PLL + IQ demod + RMS (measured on RAW MPX)
 *  - RDS measurement: Dual-mode reference:
 *      * Pilot present  -> 57 kHz = 3 × pilot PLL phase
 *      * Pilot absent   -> dedicated 57 kHz PLL locks directly to 57 kHz
 *    Smooth blend between both references (no “RDS drops to 0” just because pilot is missing)
 *  - MPX "m" measurement:
 *      * Optional peak-path lowpass (~100 kHz, clamped below Nyquist)
 *      * TruePeak via Catmull-Rom cubic interpolation (factor 4 or 8)
 *      * Peak Hold + Release envelope (ballistics)
 *  - Real-time FFT spectrum (unchanged style)
 *  - Dynamic config reload (metricsmonitor.json compatible)
 *
 * IMPORTANT:
 *  - If SR=192 kHz, Nyquist is 96 kHz, so "100 kHz LPF" is clamped to 0.45*SR (=86.4 kHz).
 *
 * Compile Windows:
 * x64: dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:PublishTrimmed=false
 * x86: dotnet publish -c Release -r win-x86 --self-contained true /p: PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:PublishTrimmed=false
 */

using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.Wave;

// ====================================================================================
//  GLOBAL CONFIG
// ====================================================================================
public static class Config
{
    public static float MeterInputCalibrationDB = 0.0f;
    public static float SpectrumInputCalibrationDB = 0.0f;
    public static float MeterGain = 1.0f;
    public static float SpectrumGain = 1.0f;

    // Display/calibration scales (same meaning as your C tool)
    public static float MeterPilotScale = 2000.0f;
    public static float MeterMPXScale = 500.0f;
    public static float MeterRDSScale = 1500.0f;

    // Spectrum smoothing
    public static float SpectrumAttack = 0.25f;
    public static float SpectrumDecay = 0.15f;
    public static int SpectrumSendInterval = 30;

    // New optional keys (match MPXCapture.c)
    //  - "TruePeakFactor": 4 or 8
    //  - "MPX_LPF_100kHz": 0/1
    public static int TruePeakFactor = 8;
    public static int MPX_LPF_100kHz = 1;

    private static string _configPath = "metricsmonitor.json";
    private static DateTime _lastModTime;

    public static void Init(string path)
    {
        if (!string.IsNullOrWhiteSpace(path))
            _configPath = path.Trim().Trim('"');

        try
        {
            string abs = Path.GetFullPath(_configPath);
            Console.Error.WriteLine($"[MPX] Config Path: '{abs}'");
        }
        catch { /* ignore */ }

        Update(force: true);
    }

    public static void Update(bool force = false)
    {
        if (!File.Exists(_configPath)) return;

        try
        {
            DateTime mod = File.GetLastWriteTime(_configPath);
            if (!force && mod == _lastModTime) return;
            _lastModTime = mod;

            string jsonString = "";
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    using (var fs = new FileStream(_configPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var sr = new StreamReader(fs))
                        jsonString = sr.ReadToEnd();

                    if (!string.IsNullOrWhiteSpace(jsonString) && jsonString.Trim().Length > 2)
                        break;
                }
                catch { Thread.Sleep(50); }
            }

            if (string.IsNullOrWhiteSpace(jsonString)) return;

            var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

            using (JsonDocument doc = JsonDocument.Parse(jsonString, options))
            {
                var root = doc.RootElement;

                float GetFloat(string k, float def)
                {
                    if (root.TryGetProperty(k, out var e))
                    {
                        if (e.ValueKind == JsonValueKind.Number && e.TryGetSingle(out float v)) return v;
                        if (e.ValueKind == JsonValueKind.String && float.TryParse(e.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out float vs)) return vs;
                    }
                    return def;
                }

                int GetInt(string k, int def)
                {
                    float f = GetFloat(k, def);
                    return (int)MathF.Round(f);
                }

                float mGain = GetFloat("MeterInputCalibration", -9999f);
                if (mGain > -9000f)
                {
                    MeterInputCalibrationDB = mGain;
                    MeterGain = (float)Math.Pow(10.0, mGain / 20.0);
                }

                float sGain = GetFloat("SpectrumInputCalibration", -9999f);
                if (sGain > -9000f)
                {
                    SpectrumInputCalibrationDB = sGain;
                    SpectrumGain = (float)Math.Pow(10.0, sGain / 20.0);
                }

                MeterPilotScale = GetFloat("MeterPilotScale", MeterPilotScale);
                MeterMPXScale = GetFloat("MeterMPXScale", MeterMPXScale);
                MeterRDSScale = GetFloat("MeterRDSScale", MeterRDSScale);

                float att = GetFloat("SpectrumAttackLevel", -9999f);
                if (att > -9000f) SpectrumAttack = Math.Clamp(att * 0.1f, 0.01f, 1.0f);

                float dec = GetFloat("SpectrumDecayLevel", -9999f);
                if (dec > -9000f) SpectrumDecay = Math.Clamp(dec * 0.01f, 0.01f, 1.0f);

                float interval = GetFloat("SpectrumSendInterval", -9999f);
                if (interval > 0) SpectrumSendInterval = (int)interval;

                // New keys
                int tpf = GetInt("TruePeakFactor", TruePeakFactor);
                if (tpf == 4 || tpf == 8) TruePeakFactor = tpf;

                MPX_LPF_100kHz = GetInt("MPX_LPF_100kHz", MPX_LPF_100kHz) != 0 ? 1 : 0;

                Console.Error.WriteLine($"[MPX] Config Update ({_configPath}):");
                Console.Error.WriteLine($"   MeterGain: {MeterInputCalibrationDB:F2} dB (x{MeterGain:F6})");
                Console.Error.WriteLine($"   Scales:    Pilot={MeterPilotScale:F4}, MPX={MeterMPXScale:F4}, RDS={MeterRDSScale:F4}");
                Console.Error.WriteLine($"   MPX Peak:  TruePeakFactor={TruePeakFactor}, MPX_LPF_100kHz={MPX_LPF_100kHz}");
                Console.Error.WriteLine($"   Spectrum:  Attack={SpectrumAttack:F3}, Decay={SpectrumDecay:F3}, Interval={SpectrumSendInterval}ms");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[MPX] Config Parse Error: {ex.Message}");
        }
    }
}

// ====================================================================================
//  FFT (for spectrum visual)
// ====================================================================================
public static class QuickFFT
{
    public static void Compute(Complex[] data)
    {
        int n = data.Length;
        int m = (int)Math.Log(n, 2);

        // Bit-reversal
        int j = 0;
        int n2 = n / 2;
        for (int i = 1; i < n - 1; i++)
        {
            int n1 = n2;
            while (j >= n1) { j -= n1; n1 >>= 1; }
            j += n1;
            if (i < j) (data[i], data[j]) = (data[j], data[i]);
        }

        // FFT
        int n1_ = 0;
        int n2_ = 1;
        for (int i = 0; i < m; i++)
        {
            n1_ = n2_;
            n2_ <<= 1;

            double a = 0.0;
            double step = -Math.PI / n1_;
            for (j = 0; j < n1_; j++)
            {
                Complex c = new Complex(Math.Cos(a), Math.Sin(a));
                a += step;

                for (int k = j; k < n; k += n2_)
                {
                    Complex t = c * data[k + n1_];
                    data[k + n1_] = data[k] - t;
                    data[k] = data[k] + t;
                }
            }
        }
    }
}

// ====================================================================================
//  BIQUAD
// ====================================================================================
public class BiQuadFilter
{
    private float a1, a2;
    private float b0, b1, b2;
    private float x1, x2, y1, y2;

    public static BiQuadFilter BandPass(float sampleRate, float frequency, float q)
    {
        var f = new BiQuadFilter();
        float w0 = 2f * MathF.PI * frequency / sampleRate;
        float alpha = MathF.Sin(w0) / (2f * q);

        float b0 = alpha;
        float b1 = 0f;
        float b2 = -alpha;
        float a0 = 1f + alpha;
        float a1 = -2f * MathF.Cos(w0);
        float a2 = 1f - alpha;

        f.b0 = b0 / a0;
        f.b1 = b1 / a0;
        f.b2 = b2 / a0;
        f.a1 = a1 / a0;
        f.a2 = a2 / a0;

        return f;
    }

    public static BiQuadFilter LowPass(float sampleRate, float frequency, float q)
    {
        var f = new BiQuadFilter();
        float w0 = 2f * MathF.PI * frequency / sampleRate;
        float alpha = MathF.Sin(w0) / (2f * q);
        float cosW0 = MathF.Cos(w0);

        float b0 = (1f - cosW0) * 0.5f;
        float b1 = 1f - cosW0;
        float b2 = (1f - cosW0) * 0.5f;
        float a0 = 1f + alpha;
        float a1 = -2f * cosW0;
        float a2 = 1f - alpha;

        f.b0 = b0 / a0;
        f.b1 = b1 / a0;
        f.b2 = b2 / a0;
        f.a1 = a1 / a0;
        f.a2 = a2 / a0;

        return f;
    }

    public float Process(float x)
    {
        float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x;
        y2 = y1; y1 = y;
        return y;
    }
}

// ====================================================================================
//  TRUEPEAK (Catmull-Rom) + PEAK HOLD/RELEASE
// ====================================================================================
public class TruePeakN
{
    private float x0, x1, x2, x3;
    private int warm;

    public void Reset()
    {
        x0 = x1 = x2 = x3 = 0f;
        warm = 0;
    }

    private static float CatmullRom(float p0, float p1, float p2, float p3, float t)
    {
        float t2 = t * t;
        float t3 = t2 * t;
        return 0.5f * (
            (2f * p1) +
            (-p0 + p2) * t +
            (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 +
            (-p0 + 3f * p1 - 3f * p2 + p3) * t3
        );
    }

    // Returns max abs value between the last segment using factor=4 or 8
    public float Process(float x, int factor)
    {
        if (factor != 8) factor = 4;

        if (warm < 4)
        {
            if (warm == 0) { x0 = x1 = x2 = x3 = x; }
            else if (warm == 1) { x1 = x2 = x3 = x; }
            else if (warm == 2) { x2 = x3 = x; }
            else { x3 = x; }
            warm++;
            return MathF.Abs(x);
        }

        x0 = x1;
        x1 = x2;
        x2 = x3;
        x3 = x;

        float maxAbs = 0f;
        for (int k = 0; k <= factor; k++)
        {
            float t = (float)k / factor;
            float y = CatmullRom(x0, x1, x2, x3, t);
            float a = MathF.Abs(y);
            if (a > maxAbs) maxAbs = a;
        }
        return maxAbs;
    }
}

public class PeakHoldRelease
{
    private int holdSamples;
    private int holdCounter;
    private float releaseCoef;
    public float Value { get; private set; }

    public void Init(int sampleRate, float holdMs, float releaseMs)
    {
        holdSamples = (int)MathF.Max(1f, sampleRate * (holdMs / 1000f));
        holdCounter = 0;
        Value = 0f;

        float tau = MathF.Max(0.001f, releaseMs / 1000f);
        // Value *= exp(-dt/tau) per sample
        releaseCoef = MathF.Exp(-1f / (sampleRate * tau));
    }

    public float Process(float x)
    {
        if (x >= Value)
        {
            Value = x;
            holdCounter = holdSamples;
            return Value;
        }

        if (holdCounter > 0)
        {
            holdCounter--;
            return Value;
        }

        Value *= releaseCoef;

        if (x > Value)
        {
            Value = x;
            holdCounter = holdSamples;
        }

        return Value;
    }
}

// ====================================================================================
//  MPX DEMODULATOR (Pilot PLL + Dual-Mode RDS reference)
// ====================================================================================
public class MpxDemodulator
{
    private readonly int sr;

    // Filters
    private readonly BiQuadFilter bpf19;
    private readonly BiQuadFilter bpf57;

    // IQ LPFs
    private readonly BiQuadFilter lpfI_Pilot;
    private readonly BiQuadFilter lpfQ_Pilot;
    private readonly BiQuadFilter lpfI_Rds;
    private readonly BiQuadFilter lpfQ_Rds;

    // Pilot PLL
    private float p_phaseRad;
    private readonly float p_w0Rad;
    private float p_integrator;
    private float p_kp, p_ki;
    private float p_errLP;
    private float p_errAlpha;

    // 57k fallback PLL
    private float r_phaseRad;
    private readonly float r_w0Rad;
    private float r_integrator;
    private float r_kp, r_ki;
    private float r_errLP;
    private float r_errAlpha;

    // Power estimators
    private float pilotPow, pilotPowAlpha;
    private float mpxPow, mpxPowAlpha;
    private float rdsPow, rdsPowAlpha;

    // RMS smoothing for magnitudes (mag^2)
    private float meanSqPilot, meanSqRds;
    private float rmsAlpha;

    // Pilot presence gate
    private int pilotPresent;
    private int presentCount;
    private int absentCount;

    // Reference blend (1 = pilot-derived, 0 = 57PLL)
    private float rdsRefBlend;
    private float blendAlpha;

    public float PilotMag { get; private set; }
    public float RdsMag { get; private set; }
    public bool PilotPresent => pilotPresent != 0;

    public MpxDemodulator(int sampleRate)
    {
        sr = sampleRate;

        bpf19 = BiQuadFilter.BandPass(sr, 19000f, 20f);
        bpf57 = BiQuadFilter.BandPass(sr, 57000f, 20f);

        lpfI_Pilot = BiQuadFilter.LowPass(sr, 50f, 0.707f);
        lpfQ_Pilot = BiQuadFilter.LowPass(sr, 50f, 0.707f);

        lpfI_Rds = BiQuadFilter.LowPass(sr, 2400f, 0.707f);
        lpfQ_Rds = BiQuadFilter.LowPass(sr, 2400f, 0.707f);

        p_w0Rad = 2f * MathF.PI * 19000f / sr;
        r_w0Rad = 2f * MathF.PI * 57000f / sr;

        // PLL design targets (same philosophy as the C version)
        const float LOOP_BW_PILOT = 2.0f;  // 1..5 Hz typical
        const float LOOP_BW_RDS = 2.0f;    // keep narrow and stable
        const float ZETA = 0.707f;

        ComputePllGains(sr, LOOP_BW_PILOT, ZETA, out p_kp, out p_ki);
        ComputePllGains(sr, LOOP_BW_RDS, ZETA, out r_kp, out r_ki);

        pilotPowAlpha = ExpAlphaFromTau(sr, 0.050f);
        mpxPowAlpha = ExpAlphaFromTau(sr, 0.100f);
        rdsPowAlpha = ExpAlphaFromTau(sr, 0.050f);

        p_errAlpha = ExpAlphaFromTau(sr, 0.010f);
        r_errAlpha = ExpAlphaFromTau(sr, 0.010f);

        rmsAlpha = ExpAlphaFromTau(sr, 0.100f);

        blendAlpha = ExpAlphaFromTau(sr, 0.050f); // 50 ms blend time

        pilotPow = 1e-6f;
        mpxPow = 1e-6f;
        rdsPow = 1e-6f;

        rdsRefBlend = 1.0f; // start assuming pilot ref
        pilotPresent = 0;

        Console.Error.WriteLine($"[PLL] Pilot: BL={LOOP_BW_PILOT:F2}Hz -> Kp={p_kp:E4} Ki={p_ki:E4}");
        Console.Error.WriteLine($"[PLL] RDS57: BL={LOOP_BW_RDS:F2}Hz -> Kp={r_kp:E4} Ki={r_ki:E4}");
        Console.Error.WriteLine("[RDS] Dual-Mode reference enabled (pilot->3x when present, 57PLL when absent).");
    }

    private static float ExpAlphaFromTau(float sampleRate, float tauSeconds)
    {
        if (tauSeconds <= 0f) return 1f;
        float dt = 1f / sampleRate;
        return 1f - MathF.Exp(-(dt / tauSeconds));
    }

    // Type-II, 2nd-order PLL discrete design (same formula used in the C version)
    private static void ComputePllGains(float sampleRate, float loopBwHz, float zeta, out float kp, out float ki)
    {
        float T = 1f / sampleRate;
        const float Kd = 0.5f; // approx with normalized multiplier PD
        const float K0 = 1f;

        float theta = (loopBwHz * T) / (zeta + (0.25f / zeta));
        float d = 1f + 2f * zeta * theta + theta * theta;

        float kp0 = (4f * zeta * theta) / d;
        float ki0 = (4f * theta * theta) / d;

        kp0 /= (Kd * K0);
        ki0 /= (Kd * K0);

        kp = kp0;
        ki = ki0;
    }

    private static float Clamp(float x, float lo, float hi) => (x < lo) ? lo : (x > hi) ? hi : x;

    private void ResetPilotPll()
    {
        p_integrator = 0f;
        p_errLP = 0f;
    }

    private void ResetRdsPll()
    {
        r_integrator = 0f;
        r_errLP = 0f;
    }

    public void Process(float rawSample)
    {
        // Broadband MPX RMS
        mpxPow += (rawSample * rawSample - mpxPow) * mpxPowAlpha;
        float mpxRms = MathF.Sqrt(MathF.Max(mpxPow, 1e-12f));

        // Pilot filtered for PLL
        float pilotFiltered = bpf19.Process(rawSample);
        pilotPow += (pilotFiltered * pilotFiltered - pilotPow) * pilotPowAlpha;
        float pilotRms = MathF.Sqrt(MathF.Max(pilotPow, 1e-12f));

        // Pilot presence gate (relative threshold)
        const float PILOT_REL_THRESH = 0.01f;
        const int PRESENT_HOLD_SAMPLES = 2000;
        const int ABSENT_HOLD_SAMPLES = 8000;

        bool presentNow = (mpxRms > 1e-9f) && ((pilotRms / (mpxRms + 1e-9f)) > PILOT_REL_THRESH);

        if (presentNow)
        {
            presentCount++;
            absentCount = 0;
            if (pilotPresent == 0 && presentCount > PRESENT_HOLD_SAMPLES)
            {
                pilotPresent = 1;
                ResetPilotPll();

                // Align 57PLL to pilot-derived phase (prevents jump)
                r_phaseRad = Wrap2Pi(3f * p_phaseRad);
                ResetRdsPll();
            }
        }
        else
        {
            absentCount++;
            presentCount = 0;
            if (pilotPresent != 0 && absentCount > ABSENT_HOLD_SAMPLES)
            {
                pilotPresent = 0;
                ResetPilotPll();
                ResetRdsPll();
            }
        }

        // ---- Pilot PLL update (free-run nominal; correct only when pilotPresent) ----
        float p_s = MathF.Sin(p_phaseRad);
        float p_err = pilotFiltered * (-p_s);
        float p_errNorm = p_err / (pilotRms + 1e-9f);

        p_errLP += (p_errNorm - p_errLP) * p_errAlpha;
        float pe = p_errLP;

        if (pilotPresent != 0)
        {
            p_integrator += p_ki * pe;

            float radPerHz = (2f * MathF.PI) / sr;
            float maxPull = 50f * radPerHz;
            p_integrator = Clamp(p_integrator, -maxPull, +maxPull);

            float freqOffset = p_kp * pe + p_integrator;
            p_phaseRad = Wrap2Pi(p_phaseRad + p_w0Rad + freqOffset);
        }
        else
        {
            p_phaseRad = Wrap2Pi(p_phaseRad + p_w0Rad);
            meanSqPilot *= 0.9995f;
        }

        // ---- Pilot IQ on RAW MPX ----
        float p_c = MathF.Cos(p_phaseRad);
        p_s = MathF.Sin(p_phaseRad);

        float I_P = lpfI_Pilot.Process(rawSample * p_c);
        float Q_P = lpfQ_Pilot.Process(rawSample * p_s);

        float magSqPilot = I_P * I_P + Q_P * Q_P;
        meanSqPilot += (magSqPilot - meanSqPilot) * rmsAlpha;

        PilotMag = (pilotPresent != 0) ? MathF.Sqrt(MathF.Max(meanSqPilot, 0f)) : 0f;

        // ---- RDS reference blend ----
        float targetBlend = (pilotPresent != 0) ? 1f : 0f;
        rdsRefBlend += (targetBlend - rdsRefBlend) * blendAlpha;

        // Pilot-derived 57 phase
        float phase57_pilot = Wrap2Pi(3f * p_phaseRad);
        float c57_p = MathF.Cos(phase57_pilot);
        float s57_p = MathF.Sin(phase57_pilot);

        // ---- 57k fallback PLL runs when pilot absent ----
        float rdsFiltered57 = bpf57.Process(rawSample);

        rdsPow += (rdsFiltered57 * rdsFiltered57 - rdsPow) * rdsPowAlpha;
        float rdsRms = MathF.Sqrt(MathF.Max(rdsPow, 1e-12f));

        if (pilotPresent == 0)
        {
            float r_s = MathF.Sin(r_phaseRad);
            float r_err = rdsFiltered57 * (-r_s);
            float r_errNorm = r_err / (rdsRms + 1e-9f);

            r_errLP += (r_errNorm - r_errLP) * r_errAlpha;
            float re = r_errLP;

            r_integrator += r_ki * re;

            float radPerHz = (2f * MathF.PI) / sr;
            float maxPull = 100f * radPerHz;
            r_integrator = Clamp(r_integrator, -maxPull, +maxPull);

            float freqOffset = r_kp * re + r_integrator;
            r_phaseRad = Wrap2Pi(r_phaseRad + r_w0Rad + freqOffset);
        }
        else
        {
            // Keep fallback PLL aligned while pilot is present
            r_phaseRad = phase57_pilot;
            r_integrator = 0f;
            r_errLP = 0f;
        }

        float c57_r = MathF.Cos(r_phaseRad);
        float s57_r = MathF.Sin(r_phaseRad);

        float b = rdsRefBlend;
        float c57 = b * c57_p + (1f - b) * c57_r;
        float s57 = b * s57_p + (1f - b) * s57_r;

        // ---- RDS IQ demod on RAW MPX (matches C behavior) ----
        float I_R = lpfI_Rds.Process(rawSample * c57);
        float Q_R = lpfQ_Rds.Process(rawSample * s57);

        float magSqRds = I_R * I_R + Q_R * Q_R;
        meanSqRds += (magSqRds - meanSqRds) * rmsAlpha;

        RdsMag = MathF.Sqrt(MathF.Max(meanSqRds, 0f));
    }

    private static float Wrap2Pi(float x)
    {
        float twoPi = 2f * MathF.PI;
        // cheap wrap
        if (x >= twoPi || x <= -twoPi)
            x = x % twoPi;
        if (x < 0f) x += twoPi;
        return x;
    }
}

// ====================================================================================
//  MAIN
// ====================================================================================
class Program
{
    // Match the C behavior as close as possible
    const float BASE_PREAMP = 3.0f;

    static void Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;

        // Args:
        //   [0] sampleRate (desired)
        //   [1] device name substring or "Default"
        //   [2] fftSize
        //   [3] config path
        int requestedSr = 192000;
        if (args.Length >= 1 && int.TryParse(args[0], out int s)) requestedSr = s;

        string devName = (args.Length >= 2 && args[1] != "Default") ? args[1].Trim('"') : "";

        int fftSize = 4096;
        if (args.Length >= 3 && int.TryParse(args[2], out int f)) fftSize = f;
        if ((fftSize & (fftSize - 1)) != 0 || fftSize < 512) fftSize = 4096;

        string cfgPath = (args.Length >= 4) ? args[3] : "metricsmonitor.json";
        Config.Init(cfgPath);

        Console.Error.WriteLine($"[MPX] C# Init RequestedSR:{requestedSr} FFT:{fftSize} Dev:'{devName}'");

        // Select audio device
        var enumerator = new MMDeviceEnumerator();
        MMDevice device = null;

        if (string.IsNullOrEmpty(devName))
        {
            device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);
        }
        else
        {
            device = enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
                               .FirstOrDefault(d => d.FriendlyName.Contains(devName, StringComparison.OrdinalIgnoreCase));
        }

        if (device == null)
        {
            Console.Error.WriteLine("[MPX] ERROR: Audio device not found.");
            return;
        }

        try
        {
            // Try to set requested format
            var requestedFormat = WaveFormat.CreateIeeeFloatWaveFormat(requestedSr, 2);
            var capture = new WasapiCapture(device, false, 20);

            try
            {
                capture.WaveFormat = requestedFormat;
            }
            catch
            {
                Console.Error.WriteLine($"[MPX] WARNING: Could not set {requestedSr} Hz; using device default.");
            }

            int actualSr = capture.WaveFormat.SampleRate;
            int channels = capture.WaveFormat.Channels;
            bool isFloat = (capture.WaveFormat.Encoding == WaveFormatEncoding.IeeeFloat);
            int bytesPerSample = capture.WaveFormat.BitsPerSample / 8;

            Console.Error.WriteLine($"[MPX] Format: {actualSr} Hz, {channels} ch, {(isFloat ? "Float32" : "PCM")} {capture.WaveFormat.BitsPerSample} bit");

            // Use actual sample rate for DSP (matches the C tool assumption)
            int sr = actualSr;

            // Spectrum buffers
            Complex[] fftBuffer = new Complex[fftSize];
            float[] window = new float[fftSize];
            float[] smoothSpectrum = new float[fftSize / 2];

            for (int i = 0; i < fftSize; i++)
                window[i] = (float)(0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (fftSize - 1))));

            // Demodulator (pilot PLL + dual-mode RDS)
            var demod = new MpxDemodulator(sr);

            // MPX peak-path LPF (~100 kHz, clamped)
            float cutoff = 100000f;
            float maxSafe = 0.45f * sr;
            if (cutoff > maxSafe) cutoff = maxSafe;

            var mpxPeakLpf = BiQuadFilter.LowPass(sr, cutoff, 0.707f);
            Console.Error.WriteLine($"[MPX] Peak-path LPF cutoff: {cutoff:F1} Hz (requested 100kHz, clamped if needed)");

            var truePeak = new TruePeakN();
            truePeak.Reset();

            var env = new PeakHoldRelease();
            env.Init(sr, holdMs: 200f, releaseMs: 1500f);

            // Channel lock (same idea as your old code)
            int activeChannel = 0;
            bool channelLocked = false;
            double energyL = 0.0, energyR = 0.0;
            int energySamples = 0;

            // Timing / output
            int fftIndex = 0;
            int counter = 0;
            int configTick = 0;

            // If device SR != requested SR, we do a simple decimation fallback.
            // This is NOT a proper resampler. Best is to capture at the real SR.
            double resamplePhase = 0.0;
            double resampleRatio = (requestedSr > 0) ? ((double)actualSr / requestedSr) : 1.0;
            bool doDecimate = (actualSr != requestedSr && requestedSr > 0 && actualSr > requestedSr);

            int outputThresh = (sr * Config.SpectrumSendInterval) / 1000;

            // Visual smoothing for p/r (only display smoothing, not measurement)
            float smoothP = 0f;
            float smoothR = 0f;

            capture.DataAvailable += (s, e) =>
            {
                if (configTick++ > 40)
                {
                    Config.Update();
                    configTick = 0;
                    outputThresh = (sr * Config.SpectrumSendInterval) / 1000;
                }

                int frameSize = channels * bytesPerSample;
                int frames = e.BytesRecorded / frameSize;

                for (int i = 0; i < frames; i++)
                {
                    int offset = i * frameSize;

                    float vL = 0f, vR = 0f;

                    if (isFloat)
                    {
                        vL = BitConverter.ToSingle(e.Buffer, offset);
                        if (channels > 1) vR = BitConverter.ToSingle(e.Buffer, offset + 4);
                    }
                    else
                    {
                        // Basic PCM handling (16/24 bit)
                        if (bytesPerSample == 2)
                        {
                            vL = BitConverter.ToInt16(e.Buffer, offset) / 32768f;
                            if (channels > 1) vR = BitConverter.ToInt16(e.Buffer, offset + 2) / 32768f;
                        }
                        else if (bytesPerSample == 3)
                        {
                            int s24L = (e.Buffer[offset] | (e.Buffer[offset + 1] << 8) | (e.Buffer[offset + 2] << 16));
                            if ((s24L & 0x800000) != 0) s24L |= unchecked((int)0xFF000000);
                            vL = s24L / 8388608f;

                            if (channels > 1)
                            {
                                int o2 = offset + 3;
                                int s24R = (e.Buffer[o2] | (e.Buffer[o2 + 1] << 8) | (e.Buffer[o2 + 2] << 16));
                                if ((s24R & 0x800000) != 0) s24R |= unchecked((int)0xFF000000);
                                vR = s24R / 8388608f;
                            }
                        }
                    }

                    // Optional simple decimation if the device runs faster than requested.
                    // (For accurate metering, prefer actualSr == requestedSr.)
                    if (doDecimate)
                    {
                        resamplePhase += 1.0;
                        if (resamplePhase < resampleRatio) continue;
                        resamplePhase -= resampleRatio;
                    }

                    // Channel lock
                    if (!channelLocked)
                    {
                        energyL += vL * vL;
                        energyR += vR * vR;
                        energySamples++;
                        if (energySamples >= 8192)
                        {
                            activeChannel = (energyR > energyL * 1.5) ? 1 : 0;
                            channelLocked = true;
                            Console.Error.WriteLine($"[MPX] Channel locked: {(activeChannel == 0 ? "LEFT" : "RIGHT")}");
                        }
                    }

                    float v = (activeChannel == 0 ? vL : vR) * BASE_PREAMP;

                    // Gains from config
                    float vMeters = v * Config.MeterGain;
                    float vSpec = v * Config.SpectrumGain;

                    // ---- MPX Peak Path ONLY ----
                    float vPeak = vMeters;
                    if (Config.MPX_LPF_100kHz != 0)
                        vPeak = mpxPeakLpf.Process(vPeak);

                    float tp = truePeak.Process(vPeak, Config.TruePeakFactor);
                    float envPeak = env.Process(tp);

                    // ---- Demod (pilot + dual-mode RDS) ----
                    demod.Process(vMeters);

                    // ---- Spectrum FFT buffer ----
                    if (fftIndex < fftSize)
                    {
                        fftBuffer[fftIndex] = new Complex(vSpec * window[fftIndex], 0.0);
                        fftIndex++;
                    }

                    counter++;

                    if (counter >= outputThresh)
                    {
                        float pScaled = demod.PilotMag * Config.MeterPilotScale;
                        float rScaled = demod.RdsMag * Config.MeterRDSScale;
                        float mScaled = envPeak * Config.MeterMPXScale;

                        // display smoothing (keeps the same “feel”)
                        smoothP = (smoothP == 0f) ? pScaled : (smoothP * 0.90f + pScaled * 0.10f);
                        smoothR = (smoothR == 0f) ? rScaled : (smoothR * 0.90f + rScaled * 0.10f);

                        if (fftIndex >= fftSize)
                        {
                            QuickFFT.Compute(fftBuffer);

                            // Keep maxBin logic similar to previous (visual only)
                            int maxBin = (int)((100000.0 / (sr / 2.0)) * (fftSize / 2.0));
                            if (maxBin > fftSize / 2) maxBin = fftSize / 2;
                            if (maxBin < 10) maxBin = 10;

                            var sb = new System.Text.StringBuilder(maxBin * 8 + 128);
                            sb.Append("{\"p\":");
                            sb.Append(smoothP.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"r\":");
                            sb.Append(smoothR.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"m\":");
                            sb.Append(mScaled.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"s\":[");

                            for (int k = 0; k < maxBin; k++)
                            {
                                float mag = (float)fftBuffer[k].Magnitude;
                                float lin = (mag * 2.0f) / fftSize;

                                if (lin > smoothSpectrum[k])
                                    smoothSpectrum[k] = smoothSpectrum[k] * (1f - Config.SpectrumAttack) + lin * Config.SpectrumAttack;
                                else
                                    smoothSpectrum[k] = smoothSpectrum[k] * (1f - Config.SpectrumDecay) + lin * Config.SpectrumDecay;

                                if (k > 0) sb.Append(',');
                                sb.Append((smoothSpectrum[k] * 15.0f).ToString("F4", CultureInfo.InvariantCulture));
                            }

                            sb.Append("]}");
                            Console.WriteLine(sb.ToString());

                            fftIndex = 0;
                        }

                        counter = 0;
                    }
                }
            };

            capture.StartRecording();
            Thread.Sleep(Timeout.Infinite);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[MPX] FATAL: {ex}");
        }
    }
}
