/*
 * MPXCapture.c
 * 
 * High-Performance MPX Analyzer Tool
 * Reads raw PCM (Float32 LE) from stdin or audio device.
 * performs FFT and Goertzel algorithms to extract MPX, Pilot, and RDS levels.
 * Outputs JSON stream to stdout.
 * 
 * Supports dynamic configuration reload from metricsmonitor.json
 * 
 * Compile Linux: gcc -O3 -lm -pthread -o MPXCapture MPXCapture.c
 * Compile Win:   cl /O2 MPXCapture.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <ctype.h>
#include <unistd.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#ifdef _WIN32
  #include <io.h>
  #include <fcntl.h>
  #include <windows.h>
  #define sleep_ms(x) Sleep(x)
#else
  #define sleep_ms(x) usleep((x)*1000)
#endif

/* ============================================================
   GLOBALS FOR DYNAMIC CONFIG
   ============================================================ */
float G_MeterInputCalibrationDB = 0.0f;
float G_SpectrumInputCalibrationDB = 0.0f;
float G_MeterGain = 1.0f;
float G_SpectrumGain = 1.0f;

// Scaling Factors
float G_MeterPilotScale = 1.0f; 
// Wir setzen hier KEINEN harten Default wie 107.14, 
// damit wir sehen, ob die Config greift. 
// Fallback passiert nur, wenn Config-Read fehlschlägt.
float G_MeterMPXScale = 100.0f; 
float G_MeterRDSScale = 1.0f;   

// Spectrum Visual Settings
float G_SpectrumAttack = 0.25f; 
float G_SpectrumDecay = 0.15f;
int G_SpectrumSendInterval = 30; 

#define BASE_PREAMP 3.0f

char G_ConfigPath[1024] = {0};
time_t G_LastConfigModTime = 0;

/* ============================================================
   JSON PARSER (Aggressive & Robust)
   ============================================================ */

// Helper to read file content with error checking
char* read_file_content(const char* filename) {
    FILE *f = fopen(filename, "rb"); // Binary mode to get exact bytes
    if (!f) return NULL;
    
    fseek(f, 0, SEEK_END);
    long fsize = ftell(f);
    fseek(f, 0, SEEK_SET);
    
    if (fsize <= 0) { fclose(f); return NULL; }

    char *string = malloc(fsize + 1);
    if (string) {
        size_t read_len = fread(string, 1, fsize, f);
        string[read_len] = 0;
    }
    fclose(f);
    return string;
}

// Advanced parser that handles "Key" : Value, "Key":Value, etc.
float get_json_float(const char* json, const char* key, float currentVal) {
    if (!json || !key) return currentVal;

    // Construct search string: "Key"
    char searchKey[128];
    snprintf(searchKey, sizeof(searchKey), "\"%s\"", key);
    
    char* pos = strstr(json, searchKey);
    if (!pos) {
        // Optional: Debug if key is totally missing
        // fprintf(stderr, "[MPX-C] Key not found: %s\n", key);
        return currentVal; 
    }
    
    // Move to end of "Key"
    pos += strlen(searchKey);
    
    // Skip formatting chars: space, tab, newline, carriage return, colon
    while(*pos && (isspace((unsigned char)*pos) || *pos == ':')) {
        pos++;
    }
    
    // Check if we hit end or invalid char
    if (!*pos || (*pos != '-' && !isdigit((unsigned char)*pos))) {
        return currentVal;
    }

    char* endPtr;
    float val = strtof(pos, &endPtr);
    
    if (pos == endPtr) return currentVal; // Conversion failed
    return val;
}

void update_config() {
    if (strlen(G_ConfigPath) == 0) return;
    
    struct stat attr;
    if (stat(G_ConfigPath, &attr) == 0) {
        
        // Always read on first run (G_LastConfigModTime == 0) OR if file changed
        if (G_LastConfigModTime == 0 || attr.st_mtime != G_LastConfigModTime) {
            
            G_LastConfigModTime = attr.st_mtime;
            
            // Retry Loop (Atomic Save fix)
            char *string = NULL;
            int attempts = 0;
            
            while (attempts < 5) { // 5 versuche
                string = read_file_content(G_ConfigPath);
                if (string && strlen(string) > 10 && strchr(string, '{')) break;
                
                if (string) { free(string); string = NULL; }
                attempts++;
                sleep_ms(50); 
            }
            
            if (string) {
                // Read Values
                
                // Gains
                float mGain = get_json_float(string, "MeterInputCalibration", -9999.0f);
                if (mGain > -9000.0f) {
                    G_MeterInputCalibrationDB = mGain;
                    G_MeterGain = powf(10.0f, G_MeterInputCalibrationDB / 20.0f);
                }

                float sGain = get_json_float(string, "SpectrumInputCalibration", -9999.0f);
                if (sGain > -9000.0f) {
                    G_SpectrumInputCalibrationDB = sGain;
                    G_SpectrumGain = powf(10.0f, G_SpectrumInputCalibrationDB / 20.0f);
                }

                // Scales - WICHTIG: Hier nutzen wir KEINEN Default, sondern den aktuellen Wert
                // Wenn get_json_float den Key nicht findet, kommt der aktuelle Wert zurück.
                // Da wir G_MeterMPXScale oben auf 100.0 gesetzt haben, sollte er überschrieben werden.
                G_MeterPilotScale = get_json_float(string, "MeterPilotScale", G_MeterPilotScale);
                G_MeterMPXScale = get_json_float(string, "MeterMPXScale", G_MeterMPXScale);
                G_MeterRDSScale = get_json_float(string, "MeterRDSScale", G_MeterRDSScale);

                // Visuals
                float att = get_json_float(string, "SpectrumAttackLevel", -9999.0f);
                if (att > -9000.0f) G_SpectrumAttack = att * 0.1f;

                float dec = get_json_float(string, "SpectrumDecayLevel", -9999.0f);
                if (dec > -9000.0f) G_SpectrumDecay = dec * 0.01f;

                float interval = get_json_float(string, "SpectrumSendInterval", -9999.0f);
                if (interval > 0.0f) G_SpectrumSendInterval = (int)interval;

                // Safety Clamps
                if (G_SpectrumAttack > 1.0f) G_SpectrumAttack = 1.0f; if (G_SpectrumAttack < 0.01f) G_SpectrumAttack = 0.01f;
                if (G_SpectrumDecay > 1.0f) G_SpectrumDecay = 1.0f;   if (G_SpectrumDecay < 0.01f) G_SpectrumDecay = 0.01f;

                // Log
                fprintf(stderr, "[MPX-C] Config Update (%s):\n", G_ConfigPath);
                fprintf(stderr, "   MeterGain: %.2f dB (x%.2f)\n", G_MeterInputCalibrationDB, G_MeterGain);
                fprintf(stderr, "   Scales:    P=%.2f, M=%.2f, R=%.2f\n", G_MeterPilotScale, G_MeterMPXScale, G_MeterRDSScale);
                fprintf(stderr, "   Spectrum:  Att=%.2f, Dec=%.2f, Int=%dms\n", G_SpectrumAttack, G_SpectrumDecay, G_SpectrumSendInterval);

                free(string);
            } else {
                 fprintf(stderr, "[MPX-C] Warn: Config file empty or locked after retries.\n");
            }
        }
    }
}

/* ============================================================
   FFT IMPL
   ============================================================ */
typedef struct { float r, i; } Complex;

static void QuickFFT(Complex *data, int n) {
    int i, j, k, n1, n2; Complex c, t;
    j = 0; n2 = n / 2;
    for (i = 1; i < n - 1; i++) {
        n1 = n2; while (j >= n1) { j -= n1; n1 >>= 1; } j += n1;
        if (i < j) { t = data[i]; data[i] = data[j]; data[j] = t; }
    }
    n1 = 0; n2 = 1;
    int stages = (int)log2((double)n);
    for (i = 0; i < stages; i++) {
        n1 = n2; n2 <<= 1;
        double a = 0; double step = -M_PI / n1; 
        for (j = 0; j < n1; j++) {
            c.r = (float)cos(a); c.i = (float)sin(a); a += step;
            for (k = j; k < n; k += n2) {
                t.r = c.r * data[k + n1].r - c.i * data[k + n1].i;
                t.i = c.r * data[k + n1].i + c.i * data[k + n1].r;
                data[k + n1].r = data[k].r - t.r; data[k + n1].i = data[k].i - t.i;
                data[k].r += t.r; data[k].i += t.i;
            }
        }
    }
}

/* ============================================================
   GOERTZEL (Optimized for Pilot 19kHz)
   ============================================================ */
typedef struct { float coeff, c, s, q1, q2; int blockSize, counter; } Goertzel;

static void GoertzelInit(Goertzel *g, float targetFreq, int sampleRate, int blockSize) {
    g->blockSize = blockSize; 
    g->counter = 0; 
    g->q1 = 0.0f;
    g->q2 = 0.0f;
    float k = (float)((int)(0.5f + ((float)blockSize * targetFreq) / (float)sampleRate));
    float omega = (2.0f * (float)M_PI * k) / (float)blockSize;
    g->c = cosf(omega); 
    g->s = sinf(omega); 
    g->coeff = 2.0f * g->c;
}

static int GoertzelProcess(Goertzel *g, float sample, float *magOut) {
    float q0 = g->coeff * g->q1 - g->q2 + sample;
    g->q2 = g->q1; 
    g->q1 = q0; 
    g->counter++;
    if (g->counter >= g->blockSize) {
        float r = g->q1 - g->q2 * g->c; 
        float i = g->q2 * g->s;
        *magOut = (2.0f * sqrtf(r*r + i*i)) / (float)g->blockSize;
        g->q1 = 0.0f;
        g->q2 = 0.0f;
        g->counter = 0; 
        return 1;
    }
    *magOut = 0.0f; 
    return 0;
}

static int is_power_of_two(int x) { return x > 0 && ((x & (x - 1)) == 0); }

/* ============================================================
   MAIN
   ============================================================ */

#define RDS_FFT_SIZE      2048 
#define RMS_CALIB_FACTOR 0.75f 

int main(int argc, char **argv)
{
    int sr = 192000;
    int fftSize = 4096;
    
    if (argc >= 2) sr = atoi(argv[1]);
    
    const char *devName = "Default";
    if (argc >= 3 && argv[2] && strlen(argv[2]) > 0) {
        devName = argv[2];
    }
    
    if (argc >= 4) fftSize = atoi(argv[3]);
    if (!is_power_of_two(fftSize) || fftSize < 512) fftSize = 4096;
    
    // WICHTIG: Config Path muss existieren
    if (argc >= 5) {
        strncpy(G_ConfigPath, argv[4], 1023);
        // Initiales Update erzwingen
        update_config(); 
    }

#ifdef _WIN32
    _setmode(_fileno(stdin),  _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    setvbuf(stdout, NULL, _IONBF, 0);

    fprintf(stderr, "[MPX] Init SR:%d, FFT:%d, Dev:'%s' | MODE: SCALED\n", sr, fftSize, devName);

    // Buffers
    float *window = (float*)malloc(sizeof(float) * (size_t)fftSize);
    Complex *fftBuf = (Complex*)malloc(sizeof(Complex) * (size_t)fftSize);
    float *smoothBuf = (float*)calloc(fftSize / 2, sizeof(float));
    
    Complex *rdsFftBuf = (Complex*)malloc(sizeof(Complex) * RDS_FFT_SIZE);
    float *rdsWindow = (float*)malloc(sizeof(float) * RDS_FFT_SIZE);
    int rdsFftIdx = 0;
    
    #define RDS_AVG_LEN 10
    float rdsHistory[RDS_AVG_LEN];
    for(int i=0; i<RDS_AVG_LEN; i++) rdsHistory[i] = 0.0f;
    int rdsHistIdx = 0;
    float currentSmoothedRds = 0.0f;

    if (!window || !fftBuf || !smoothBuf || !rdsFftBuf || !rdsWindow) {
        fprintf(stderr, "[MPX] Memory allocation failed!\n");
        return 1;
    }

    // Windows
    for (int i = 0; i < fftSize; i++)
        window[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)i / (float)(fftSize - 1)));
    
    for (int i = 0; i < RDS_FFT_SIZE; i++)
        rdsWindow[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)i / (float)(RDS_FFT_SIZE - 1)));

    // Tools
    int fftIndex = 0;
    Goertzel pilot; 
    GoertzelInit(&pilot, 19000.0f, sr, 1920); 

    int active_channel = 0; 
    int channel_locked = 0;
    double energyL = 0.0, energyR = 0.0;
    int energy_samples = 0;

    float maxMpx = 0.0f;
    float smoothP = 0.0f;
    float verySmoothRdsDisplay = 0.0f;

    int counter = 0;
    int configCheckCounter = 0;
    
    // Output interval
    int outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;

    // Peak Hold
    int historyLen = sr / 4800; 
    if (historyLen < 1) historyLen = 1; 
    if (historyLen > 100) historyLen = 100; 
    
    float *peakHistory = (float*)calloc(historyLen, sizeof(float));
    int peakHistoryIdx = 0;

    // RDS Bins
    float binWidth = (float)sr / (float)RDS_FFT_SIZE;
    int rdsBinStart = (int)(54000.0f / binWidth); 
    int rdsBinEnd   = (int)(60000.0f / binWidth); 

    float in[2048 * 2];
    int maxBin = fftSize / 2;

    // --- MAIN LOOP ---
    while (fread(in, sizeof(float), 2048*2, stdin) == 2048*2) {
        
        configCheckCounter++;
        if (configCheckCounter > 50) { 
            update_config();
            outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;
            configCheckCounter = 0;
        }

        for (int i = 0; i < 2048; i++) {
            
            float vL = in[i*2];
            float vR = in[i*2 + 1];

            if (!channel_locked) {
                energyL += (double)vL * (double)vL;
                energyR += (double)vR * (double)vR;
                energy_samples++;
                if (energy_samples >= 4096) {
                    active_channel = (energyR > energyL * 1.2) ? 1 : 0;
                    channel_locked = 1;
                    fprintf(stderr, "[MPX] Channel locked: %s\n", active_channel ? "RIGHT" : "LEFT");
                }
            }
            float v = (active_channel == 0 ? vL : vR);
            v *= BASE_PREAMP; 

            float vMeters = v * G_MeterGain;   
            float vSpec   = v * G_SpectrumGain; 

            // MPX Peak
            if (fabsf(vMeters) > maxMpx) maxMpx = fabsf(vMeters);

            // Pilot
            float pVal = 0.0f;
            if (GoertzelProcess(&pilot, vMeters, &pVal)) {
                smoothP = (smoothP * 0.9f) + (pVal * 0.1f);
            }

            // RDS
            rdsFftBuf[rdsFftIdx].r = vMeters * rdsWindow[rdsFftIdx];
            rdsFftBuf[rdsFftIdx].i = 0.0f;
            rdsFftIdx++;

            if (rdsFftIdx >= RDS_FFT_SIZE) {
                QuickFFT(rdsFftBuf, RDS_FFT_SIZE);
                double energySum = 0.0;
                for(int b = rdsBinStart; b <= rdsBinEnd; b++) {
                    float r = rdsFftBuf[b].r;
                    float i = rdsFftBuf[b].i;
                    energySum += (double)(r*r + i*i);
                }
                float rdsRms = (float)sqrt(energySum);
                float rawVal = (rdsRms * 2.0f * RMS_CALIB_FACTOR) / (float)RDS_FFT_SIZE;
                rdsHistory[rdsHistIdx] = rawVal;
                rdsHistIdx = (rdsHistIdx + 1) % RDS_AVG_LEN;
                float avg = 0.0f;
                for(int j=0; j<RDS_AVG_LEN; j++) avg += rdsHistory[j];
                currentSmoothedRds = avg / (float)RDS_AVG_LEN;
                rdsFftIdx = 0;
            }

            // Spectrum
            if (fftIndex < fftSize) {
                fftBuf[fftIndex].r = vSpec * window[fftIndex];
                fftBuf[fftIndex].i = 0.0f;
                fftIndex++;
            }

            counter++;

            // OUTPUT
            if (counter >= outputSampleThreshold) {
                float pFinal = smoothP * G_MeterPilotScale;
                
                float rRaw = currentSmoothedRds * G_MeterRDSScale;
                if (verySmoothRdsDisplay == 0.0f) verySmoothRdsDisplay = rRaw;
                else verySmoothRdsDisplay = (verySmoothRdsDisplay * 0.90f) + (rRaw * 0.10f);

                peakHistory[peakHistoryIdx] = maxMpx;
                peakHistoryIdx = (peakHistoryIdx + 1) % historyLen;
                float globalMax = 0.0f;
                for(int h=0; h<historyLen; h++) {
                    if (peakHistory[h] > globalMax) globalMax = peakHistory[h];
                }
                float mFinal = globalMax * G_MeterMPXScale;

                if (fftIndex >= fftSize) {
                    QuickFFT(fftBuf, fftSize);
                    printf("{\"p\":%.4f,\"r\":%.4f,\"m\":%.4f,\"s\":[", pFinal, verySmoothRdsDisplay, mFinal);
                    for (int k = 0; k < maxBin; k++) {
                        float mag = hypotf(fftBuf[k].r, fftBuf[k].i);
                        float linearAmp = (mag * 2.0f) / (float)fftSize;
                        
                        if (linearAmp > smoothBuf[k]) {
                            smoothBuf[k] = (smoothBuf[k] * (1.0f - G_SpectrumAttack)) + (linearAmp * G_SpectrumAttack);
                        } else {
                            smoothBuf[k] = (smoothBuf[k] * (1.0f - G_SpectrumDecay)) + (linearAmp * G_SpectrumDecay);
                        }

                        if (k) printf(",");
                        printf("%.4f", smoothBuf[k] * 15.0f); 
                    }
                    printf("]}\n");
                    fftIndex = 0;
                }
                maxMpx = 0.0f;
                counter = 0;
            }
        }
    }

    free(peakHistory);
    free(smoothBuf);
    free(window);
    free(fftBuf);
    free(rdsFftBuf);
    free(rdsWindow);
    return 0;
}