/*
 * MPXCapture
 * 
 * High-Performance MPX Analyzer Tool
 * performs FFT and Goertzel algorithms to extract MPX, Pilot, and RDS levels.
 * Outputs JSON stream to stdout.
 * 
 * Supports dynamic configuration reload from metricsmonitor.json
 * 
 * Compile Windows x64: dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:PublishTrimmed=false
 * Compile Windows x86: dotnet publish -c Release -r win-x86 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:PublishTrimmed=false
 */

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using System.Numerics;
using System.Globalization;
using System.Diagnostics;

// ====================================================================================
//  GLOBAL CONFIG MANAGER
// ====================================================================================
public static class Config
{

    public static float MeterInputCalibrationDB = 0.0f;
    public static float SpectrumInputCalibrationDB = 0.0f;
    public static float MeterGain = 1.0f;
    public static float SpectrumGain = 1.0f;
    
    public static float MeterPilotScale = 2000.0f; 
    public static float MeterMPXScale = 500.0f;
    public static float MeterRDSScale = 1500.0f;

    public static float SpectrumAttack = 0.25f;
    public static float SpectrumDecay = 0.15f;
    public static int SpectrumSendInterval = 30;

    private static string _configPath = "metricsmonitor.json";
    private static DateTime _lastModTime;

    public static void Init(string path)
    {
        if (!string.IsNullOrEmpty(path)) _configPath = path;
        try {
            string absPath = Path.GetFullPath(_configPath);
            Console.Error.WriteLine($"[MPX-C] Config Path: '{absPath}'");
        } catch {}
        
        Update(true);
    }

    public static void Update(bool force = false)
    {
        if (!File.Exists(_configPath)) return;
        try
        {
            var currentModTime = File.GetLastWriteTime(_configPath);
            if (!force && currentModTime == _lastModTime) return;
            _lastModTime = currentModTime;

            string jsonString = "";
            for (int i = 0; i < 5; i++) {
                try {
                    using (var fs = new FileStream(_configPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var sr = new StreamReader(fs)) { jsonString = sr.ReadToEnd(); }
                    if (jsonString.Trim().Length > 2) break;
                } catch { Thread.Sleep(50); }
            }

            if (string.IsNullOrWhiteSpace(jsonString)) return;

            var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

            using (JsonDocument doc = JsonDocument.Parse(jsonString, options))
            {
                var root = doc.RootElement;
                float GetVal(string k, float def) {
                    if (root.TryGetProperty(k, out var e)) {
                        if (e.ValueKind == JsonValueKind.Number && e.TryGetSingle(out float v)) return v;
                        if (e.ValueKind == JsonValueKind.String && float.TryParse(e.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out float vStr)) return vStr;
                    }
                    return def;
                }

                float mGain = GetVal("MeterInputCalibration", -9999f);
                if (mGain > -9000f) { MeterInputCalibrationDB = mGain; MeterGain = (float)Math.Pow(10, mGain / 20.0); }

                float sGain = GetVal("SpectrumInputCalibration", -9999f);
                if (sGain > -9000f) { SpectrumInputCalibrationDB = sGain; SpectrumGain = (float)Math.Pow(10, sGain / 20.0); }

                // Skalen laden
                MeterPilotScale = GetVal("MeterPilotScale", MeterPilotScale);
                MeterMPXScale = GetVal("MeterMPXScale", MeterMPXScale);
                MeterRDSScale = GetVal("MeterRDSScale", MeterRDSScale);

                float att = GetVal("SpectrumAttackLevel", -9999f);
                if (att > -9000f) SpectrumAttack = Math.Clamp(att * 0.1f, 0.01f, 1.0f);

                float dec = GetVal("SpectrumDecayLevel", -9999f);
                if (dec > -9000f) SpectrumDecay = Math.Clamp(dec * 0.01f, 0.01f, 1.0f);

                float interval = GetVal("SpectrumSendInterval", -9999f);
                if (interval > 0) SpectrumSendInterval = (int)interval;
                
                Console.Error.WriteLine($"[MPX-C] Config Update ({_configPath}):");
                Console.Error.WriteLine($"   MeterGain: {MeterInputCalibrationDB:F2} dB (x{MeterGain:F2})");
                Console.Error.WriteLine($"   Scales:    P={MeterPilotScale:F2}, M={MeterMPXScale:F2}, R={MeterRDSScale:F2}");
            }
        }
        catch (Exception ex) { 
            Console.Error.WriteLine($"[MPX-C] Config Parse Error: {ex.Message}"); 
        }
    }
}

// ====================================================================================
//  MATH HELPERS
// ====================================================================================
public static class QuickFFT
{
    public static void Compute(Complex[] data)
    {
        int n = data.Length;
        int m = (int)Math.Log(n, 2);
        int j = 0, n2 = n / 2;
        // Bit Reverse
        for (int i = 1; i < n - 1; i++) {
            int n1 = n2;
            while (j >= n1) { j -= n1; n1 /= 2; }
            j += n1;
            if (i < j) (data[i], data[j]) = (data[j], data[i]);
        }
        // FFT
        int n1_ = 0, n2_ = 1;
        for (int i = 0; i < m; i++) {
            n1_ = n2_; n2_ *= 2;
            double a = 0;
            double step = -Math.PI / n1_;
            for (j = 0; j < n1_; j++) {
                var c = new Complex(Math.Cos(a), Math.Sin(a));
                a += step;
                for (int k = j; k < n; k += n2_) {
                    var t = c * data[k + n1_];
                    data[k + n1_] = data[k] - t;
                    data[k] = data[k] + t;
                }
            }
        }
    }
}

public class Goertzel
{
    private float _coeff, _cos, _sin, _q1, _q2;
    private int _blockSize, _counter;
    public Goertzel(float targetFreq, int sampleRate, int blockSize) {
        _blockSize = blockSize;
        float k = (int)(0.5 + ((float)_blockSize * targetFreq) / sampleRate);
        float omega = (2.0f * MathF.PI * k) / _blockSize;
        _cos = MathF.Cos(omega); _sin = MathF.Sin(omega); _coeff = 2.0f * _cos;
    }
    public bool Process(float sample, out float mag) {
        float q0 = _coeff * _q1 - _q2 + sample;
        _q2 = _q1; _q1 = q0; _counter++;
        if (_counter >= _blockSize) {
            float r = _q1 - _q2 * _cos; float i = _q2 * _sin;
            mag = (2.0f * MathF.Sqrt(r*r + i*i)) / _blockSize;
            _q1 = 0; _q2 = 0; _counter = 0; return true;
        }
        mag = 0; return false;
    }
}

// ====================================================================================
//  MAIN
// ====================================================================================
class Program
{
    const float BASE_PREAMP = 5.0f; 
    const int RDS_FFT_SIZE = 4096;
    const float RMS_CALIB_FACTOR = 0.75f;
    const int RDS_AVG_LEN = 10;

    static void Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;

        // --- ARGS ---
        int targetSr = 192000;
        if (args.Length >= 1 && int.TryParse(args[0], out int s)) targetSr = s;
        
        string devName = (args.Length >= 2 && args[1] != "Default") ? args[1].Trim('"') : "";
        
        int fftSize = 4096; 
        if (args.Length >= 3 && int.TryParse(args[2], out int f)) fftSize = f;
        if ((fftSize & (fftSize - 1)) != 0 || fftSize < 512) fftSize = 4096; 

        // Config Path aus Args[3]
        string cfgPath = (args.Length >= 4) ? args[3] : "plugins_configs/metricsmonitor.json";
        cfgPath = cfgPath.Trim('"');
        Config.Init(cfgPath);

        Console.Error.WriteLine($"[C#] Init SR:{targetSr} FFT:{fftSize} Dev:'{devName}'");

        // --- AUDIO DEVICE ---
        var enumerator = new MMDeviceEnumerator();
        MMDevice device = null;
        if (string.IsNullOrEmpty(devName)) {
            device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);
        } else {
            device = enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
                .FirstOrDefault(d => d.FriendlyName.Contains(devName, StringComparison.OrdinalIgnoreCase));
        }
        
        if (device == null) {
             Console.Error.WriteLine("[C#] Error: Audio device not found!");
             return;
        }

        try
        {
            var capture = new WasapiCapture(device);
            
            int actualSr = capture.WaveFormat.SampleRate;
            int channels = capture.WaveFormat.Channels;
            bool isFloat = (capture.WaveFormat.Encoding == WaveFormatEncoding.IeeeFloat);
            int bytesPerSample = capture.WaveFormat.BitsPerSample / 8;

            Console.Error.WriteLine($"[C#] Format: {actualSr}Hz, {channels}ch, {(isFloat?"Float32":"PCM")}, {capture.WaveFormat.BitsPerSample}bit");

            int mathSr = actualSr; 
            
            // --- BUFFERS ---
            var pilot = new Goertzel(19000, mathSr, mathSr / 100); 
            
            Complex[] fftBuffer = new Complex[fftSize];
            float[] window = new float[fftSize];
            float[] smoothSpectrum = new float[fftSize / 2];
            
            Complex[] rdsFftBuffer = new Complex[RDS_FFT_SIZE];
            float[] rdsWindow = new float[RDS_FFT_SIZE];
            float[] rdsHistory = new float[RDS_AVG_LEN];
            
            for(int i=0; i<fftSize; i++) 
                window[i] = (float)(0.5 * (1 - Math.Cos(2 * Math.PI * i / (fftSize - 1))));
            for(int i=0; i<RDS_FFT_SIZE; i++) 
                rdsWindow[i] = (float)(0.5 * (1 - Math.Cos(2 * Math.PI * i / (RDS_FFT_SIZE - 1))));

            float binWidth = (float)mathSr / RDS_FFT_SIZE;
            int rdsBinStart = (int)(54000.0f / binWidth);
            int rdsBinEnd = (int)(60000.0f / binWidth);
            if (rdsBinStart >= RDS_FFT_SIZE/2) rdsBinStart = RDS_FFT_SIZE/2 - 1;
            if (rdsBinEnd >= RDS_FFT_SIZE/2) rdsBinEnd = RDS_FFT_SIZE/2 - 1;

            int fftIndex = 0;
            int rdsFftIndex = 0;
            int rdsHistIdx = 0;
            float currentSmoothedRds = 0;
            float verySmoothRdsDisplay = 0;
            
            int activeChannel = 0;
            bool channelLocked = false;
            double energyL = 0, energyR = 0;
            int energySamples = 0;

            float maxMpx = 0;
            float smoothP = 0;
            int counter = 0;
            int configTick = 0;

            int historyLen = mathSr / 4800;
            if (historyLen < 1) historyLen = 1; if (historyLen > 100) historyLen = 100;
            float[] peakHistory = new float[historyLen];
            int peakHistoryIdx = 0;
            
            bool signalWarned = false;
            double signalSum = 0;
            long signalSamples = 0;

            capture.DataAvailable += (s, e) =>
            {
                if (configTick++ > 40) { Config.Update(); configTick = 0; }
                
                int frameSize = channels * bytesPerSample;
                int frames = e.BytesRecorded / frameSize;
                int outputThresh = (mathSr * Config.SpectrumSendInterval) / 1000;

                for (int i = 0; i < frames; i++)
                {
                    int offset = i * frameSize;
                    float vL = 0f, vR = 0f;

                    if (isFloat) {
                        vL = BitConverter.ToSingle(e.Buffer, offset);
                        if (channels > 1) vR = BitConverter.ToSingle(e.Buffer, offset + 4);
                    } else {
                        if (bytesPerSample == 2) {
                            vL = BitConverter.ToInt16(e.Buffer, offset) / 32768f;
                            if (channels > 1) vR = BitConverter.ToInt16(e.Buffer, offset + 2) / 32768f;
                        } 
                        else if (bytesPerSample == 3) {
                             int s24L = (e.Buffer[offset] | (e.Buffer[offset+1]<<8) | (e.Buffer[offset+2]<<16));
                             if ((s24L & 0x800000) != 0) s24L |= unchecked((int)0xFF000000);
                             vL = s24L / 8388608f;
                        }
                    }

                    // Channel Locking
                    if (!channelLocked) {
                        energyL += vL * vL;
                        energyR += vR * vR;
                        energySamples++;
                        if (energySamples >= 8192) {
                            activeChannel = (energyR > energyL * 1.5) ? 1 : 0;
                            channelLocked = true;
                            Console.Error.WriteLine($"[C#] Lock: {(activeChannel==0?"LEFT":"RIGHT")}");
                        }
                    }
                    
                    if (!signalWarned) {
                        signalSum += Math.Abs(vL) + Math.Abs(vR);
                        signalSamples++;
                        if (signalSamples > 48000 && (signalSum / signalSamples) < 0.00001) {
                            Console.Error.WriteLine("[C#] WARNING: Input signal is SILENT!");
                            signalWarned = true;
                        }
                    }

                    // --- CALCULATION PIPELINE ---
                    
                    // 1. Select Channel & Base Preamp
                    float v = (activeChannel == 0 ? vL : vR) * BASE_PREAMP;
                    
                    // 2. Apply Dynamic Config Gains
                    float vMeters = v * Config.MeterGain;
                    float vSpec = v * Config.SpectrumGain;

                    // 3. MPX Peak
                    if (Math.Abs(vMeters) > maxMpx) maxMpx = Math.Abs(vMeters);

                    // 4. Pilot (Goertzel)
                    if (pilot.Process(vMeters, out float pVal)) {
                        smoothP = (smoothP * 0.9f) + (pVal * 0.1f);
                    }

                    // 5. RDS (FFT)
                    if (rdsFftIndex < RDS_FFT_SIZE) {
                        rdsFftBuffer[rdsFftIndex] = new Complex(vMeters * rdsWindow[rdsFftIndex], 0);
                        rdsFftIndex++;
                    } else {
                        QuickFFT.Compute(rdsFftBuffer);
                        double eSum = 0;
                        for(int b = rdsBinStart; b <= rdsBinEnd; b++) {
                            double re = rdsFftBuffer[b].Real;
                            double im = rdsFftBuffer[b].Imaginary;
                            eSum += (re*re + im*im);
                        }
                        float rawVal = ((float)Math.Sqrt(eSum) * 2.0f * RMS_CALIB_FACTOR) / RDS_FFT_SIZE;
                        rdsHistory[rdsHistIdx] = rawVal;
                        rdsHistIdx = (rdsHistIdx + 1) % RDS_AVG_LEN;
                        currentSmoothedRds = rdsHistory.Average();
                        rdsFftIndex = 0;
                    }

                    // 6. Spectrum
                    if (fftIndex < fftSize) {
                        fftBuffer[fftIndex] = new Complex(vSpec * window[fftIndex], 0);
                        fftIndex++;
                    }

                    counter++;

                    // --- OUTPUT ---
                    if (counter >= outputThresh) {

                        float pFinal = smoothP * Config.MeterPilotScale;
                        float rFinal = currentSmoothedRds * Config.MeterRDSScale;
                        
                        if (verySmoothRdsDisplay == 0) verySmoothRdsDisplay = rFinal;
                        else verySmoothRdsDisplay = (verySmoothRdsDisplay * 0.9f) + (rFinal * 0.1f);

                        peakHistory[peakHistoryIdx] = maxMpx;
                        peakHistoryIdx = (peakHistoryIdx + 1) % historyLen;
                        float mFinal = peakHistory.Max() * Config.MeterMPXScale;

                        if (fftIndex >= fftSize) {
                            QuickFFT.Compute(fftBuffer);
                            
                            int maxBin = (int)((100000.0 / (mathSr / 2.0)) * (fftSize / 2.0));
                            if(maxBin > fftSize/2) maxBin = fftSize/2;
                            if(maxBin < 10) maxBin = 10;

                            var sb = new System.Text.StringBuilder(maxBin * 8 + 100);
                            sb.Append("{\"p\":");
                            // Formatiere mit 4 Nachkommastellen, damit Node.js keine "0" liest
                            sb.Append(pFinal.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"r\":");
                            sb.Append(verySmoothRdsDisplay.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"m\":");
                            sb.Append(mFinal.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"s\":[");
                            
                            for(int k=0; k < maxBin; k++) {
                                float mag = (float)fftBuffer[k].Magnitude;
                                float lin = (mag * 2.0f) / fftSize;
                                
                                if (lin > smoothSpectrum[k]) smoothSpectrum[k] = (smoothSpectrum[k] * (1f-Config.SpectrumAttack)) + (lin * Config.SpectrumAttack);
                                else smoothSpectrum[k] = (smoothSpectrum[k] * (1f-Config.SpectrumDecay)) + (lin * Config.SpectrumDecay);

                                if (k>0) sb.Append(',');
                                sb.Append((smoothSpectrum[k] * 15.0f).ToString("F4", CultureInfo.InvariantCulture));
                            }
                            sb.Append("]}");
                            Console.WriteLine(sb.ToString());
                            fftIndex = 0;
                        }
                        maxMpx = 0; counter = 0;
                    }
                }
            };

            capture.StartRecording();
            Thread.Sleep(Timeout.Infinite);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[C#] FATAL ERROR: {ex}"); }
    }
}