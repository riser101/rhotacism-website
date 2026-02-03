/**
 * SpectrogramAudioProcessor
 *
 * A real-time audio processor using Linear Predictive Coding (LPC)
 * to generate spectrogram data for visualization.
 *
 * Ported from Swift implementation in RhotacismApp
 */

class SpectrogramAudioProcessor {
    constructor() {
        // Audio setup
        this.audioContext = null;
        this.mediaStreamSource = null;
        this.scriptProcessor = null;
        this.isRecording = false;

        // LPC parameters
        this.sampleRate = 44100;
        this.frameSize = 512;
        this.lpcOrder = 64;
        this.maxLpcFreq = 4096;
        this.lpcDisplayRes = 64;
        this.sensitivity = 60;

        // Smoothing parameters (lower = smoother/slower animation)
        this.fadeJumpUp = 0.03;
        this.fadeJumpDown = 0.03;
        this.targetSpace = 0.001;

        // State
        this.magnitudes = [];
        this.peaks = [];
        this.previousMagnitudes = [];
        this.delsmp = 0.0;
        this.theta = null;

        // Vibration feedback
        this.lastVibrationTime = 0;
        this.vibrationDebounceMs = 500;

        // Callbacks
        this.onMagnitudesUpdated = null;
        this.onPeaksUpdated = null;
    }

    /**
     * Request microphone permission and start recording
     * @returns {Promise<boolean>} - Returns true if successfully started, false otherwise
     */
    async startRecording() {
        if (this.isRecording) return true;

        // Check if getUserMedia is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.error('❌ getUserMedia not supported in this browser');
            return false;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.setupAudioProcessing(stream);
            return true;
        } catch (error) {
            console.error('❌ Microphone permission denied or error:', error.message);
            return false;
        }
    }

    /**
     * Set up audio context and processing
     */
    setupAudioProcessing(stream) {
        try {
            // Create audio context
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContext();

            // Create media stream source
            this.mediaStreamSource = this.audioContext.createMediaStreamSource(stream);

            // Create script processor for real-time processing
            this.scriptProcessor = this.audioContext.createScriptProcessor(
                this.frameSize * 2,
                1,
                1
            );

            // Handle audio processing
            this.scriptProcessor.onaudioprocess = (event) => {
                this.processAudioBuffer(event.inputBuffer);
            };

            // Connect nodes
            this.mediaStreamSource.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);

            this.isRecording = true;
        } catch (error) {
            console.error('❌ Failed to setup audio processing:', error.message);
            this.isRecording = false;
        }
    }

    /**
     * Stop recording and clean up
     */
    stopRecording() {
        if (!this.isRecording) return;

        try {
            if (this.scriptProcessor) {
                this.scriptProcessor.disconnect();
                this.scriptProcessor.onaudioprocess = null;
            }

            if (this.mediaStreamSource) {
                this.mediaStreamSource.disconnect();
            }

            if (this.audioContext) {
                this.audioContext.close();
            }

            this.isRecording = false;
            this.magnitudes = [];
            this.peaks = [];
            this.previousMagnitudes = [];
            console.log('✅ Audio recording stopped');
        } catch (error) {
            console.error('⚠️ Error stopping recording:', error.message);
        }
    }

    /**
     * Process incoming audio buffer
     */
    processAudioBuffer(buffer) {
        const channelData = buffer.getChannelData(0);

        // Extract frame
        let audioData = [];
        for (let i = 0; i < Math.min(channelData.length, this.frameSize); i++) {
            audioData.push(channelData[i]);
        }

        // Compute LPC coefficients
        const lpcCoeffs = this.computeLPC(audioData);

        // Get frequency response
        let newMagnitudes = this.getFrequenciesFromLPC(lpcCoeffs);

        // Expand and scale
        newMagnitudes = this.expandArraySmoothly(newMagnitudes, 512);
        newMagnitudes = this.scaleMagnitudes(newMagnitudes);

        // Smooth transition
        if (this.previousMagnitudes.length === 0) {
            this.previousMagnitudes = [...newMagnitudes];
        } else {
            newMagnitudes = this.updateMagnitudes(newMagnitudes);
        }

        // Normalize
        newMagnitudes = this.normalizeIfNecessary(newMagnitudes);

        // Find peaks
        const newPeaks = this.getPeaks(newMagnitudes);

        // Update state
        this.previousMagnitudes = [...newMagnitudes];
        this.magnitudes = newMagnitudes;
        this.peaks = newPeaks;

        // Trigger callbacks
        if (this.onMagnitudesUpdated) {
            this.onMagnitudesUpdated(this.magnitudes);
        }
        if (this.onPeaksUpdated) {
            this.onPeaksUpdated(this.peaks);
        }

        // Check for peak alignment and vibration
        this.checkThirdPeakAlignment(this.peaks);
    }

    // ===== LPC Analysis Functions =====

    /**
     * Generate Hann window
     */
    hannWindow(size) {
        const W = 0.8165;
        const result = [];
        for (let i = 0; i < size; i++) {
            result.push(W * (1 - Math.cos(2 * Math.PI * i / size)));
        }
        return result;
    }

    /**
     * Calculate mean of array
     */
    mean(buffer) {
        if (buffer.length === 0) return 0;
        return buffer.reduce((a, b) => a + b, 0) / buffer.length;
    }

    /**
     * High-pass filter to remove DC offset
     */
    highPassFilter(inBuffer) {
        const magicFactor = 0.95;
        const result = [];

        for (let i = 0; i < inBuffer.length; i++) {
            result.push(inBuffer[i] - magicFactor * this.delsmp);
            this.delsmp = inBuffer[i];
        }

        return result;
    }

    /**
     * Compute autocorrelation
     */
    autocorr(data) {
        const size = data.length;
        const result = new Array(Math.floor(size / 2)).fill(0);

        for (let i = 0; i < Math.floor(size / 2); i++) {
            for (let j = 0; j < size - i - 1; j++) {
                result[i] += data[i + j] * data[j];
            }
        }

        const norm = 1.0 / size;
        const k = Math.floor(size / 2);
        for (let i = 0; i < Math.floor(size / 2); i++) {
            result[i] *= (k - i) * norm;
        }

        return result;
    }

    /**
     * Levinson-Durbin algorithm for LPC coefficients
     */
    levinsonDurbin(r, order) {
        if (r.length <= 1 || r[0] === 0) {
            return new Array(order).fill(0);
        }

        let a = new Array(order + 1).fill(0);
        let e = r[0];

        for (let i = 1; i <= order; i++) {
            if (i >= r.length) break;

            let lambda = r[i];
            for (let j = 1; j < i; j++) {
                if (j < r.length) {
                    lambda -= a[j] * r[i - j];
                }
            }

            if (e === 0) break;
            lambda /= e;

            // Update coefficients
            let newA = [...a];
            for (let j = 1; j < i; j++) {
                newA[j] = a[j] - lambda * a[i - j];
            }
            newA[i] = lambda;
            a = newA;

            e *= (1 - lambda * lambda);
        }

        return a.slice(1, order + 1);
    }

    /**
     * Compute LPC coefficients from audio buffer
     */
    computeLPC(audioBuffer) {
        if (audioBuffer.length === 0) return [1.0];

        const bufferSize = audioBuffer.length;

        // Apply windowing and preprocessing
        const window = this.hannWindow(bufferSize);
        const meanVal = this.mean(audioBuffer);

        let processedBuffer = audioBuffer.map((val, i) => (val - meanVal) * window[i]);
        processedBuffer = this.highPassFilter(processedBuffer);

        // Compute autocorrelation
        const corr = this.autocorr(processedBuffer);

        // Levinson-Durbin algorithm
        let lpcCoeffs = this.levinsonDurbin(corr, this.lpcOrder);

        // Prepend 1.0 and negate
        let result = [1.0];
        for (let i = 0; i < Math.min(this.lpcOrder, lpcCoeffs.length); i++) {
            result.push(-lpcCoeffs[i]);
        }

        return result;
    }

    /**
     * Get frequency response from LPC coefficients
     */
    getFrequenciesFromLPC(lpcCoeffs) {
        // Pre-compute theta if not done yet
        if (this.theta === null) {
            const inc = (this.maxLpcFreq / this.lpcDisplayRes) * Math.PI / (this.sampleRate / 2);
            this.theta = [];
            for (let i = 0; i <= this.lpcDisplayRes; i++) {
                this.theta.push(i * inc);
            }
        }

        const H = new Array(this.lpcDisplayRes).fill(0);

        for (let z = 0; z < this.lpcDisplayRes; z++) {
            let realPart = 0.0;
            let imagPart = 0.0;

            for (let j = 0; j < lpcCoeffs.length; j++) {
                const angle = this.theta[z] * j + 1;
                realPart += lpcCoeffs[j] * Math.cos(angle);
                imagPart += lpcCoeffs[j] * Math.sin(angle);
            }

            const denominator = realPart * realPart + imagPart * imagPart;
            if (denominator > 0) {
                H[z] = Math.log10(1.0 / Math.sqrt(denominator));
            }
        }

        return H;
    }

    /**
     * Expand array smoothly from source to target resolution
     */
    expandArraySmoothly(source, targetResolution) {
        if (source.length === 0) return [];

        const numSteps = targetResolution / source.length;
        const result = [];

        for (let i = 0; i < source.length; i++) {
            const current = source[i];
            const stepDiff = (i < source.length - 1) ? (source[i + 1] - current) / numSteps : 0;

            for (let j = 0; j < Math.floor(numSteps); j++) {
                result.push(current + stepDiff * j);
            }
        }

        return result;
    }

    /**
     * Scale magnitudes by sensitivity
     */
    scaleMagnitudes(mags) {
        const factor = this.sensitivity / 100.0;
        return mags.map(val => val * factor);
    }

    /**
     * Update magnitudes with smooth transitions
     */
    updateMagnitudes(newMagnitudes) {
        if (this.previousMagnitudes.length !== newMagnitudes.length) {
            return newMagnitudes;
        }

        const result = [];
        for (let i = 0; i < newMagnitudes.length; i++) {
            const target = newMagnitudes[i];
            const current = this.previousMagnitudes[i];

            if (current > target - this.targetSpace / 2 && current < target + this.targetSpace / 2) {
                result.push(current);
            } else if (current < target) {
                result.push(current + (target - current) * this.fadeJumpUp);
            } else {
                result.push(Math.max(current - this.fadeJumpDown * (current - target), 0));
            }
        }

        return result;
    }

    /**
     * Normalize magnitudes if necessary
     */
    normalizeIfNecessary(mags) {
        const maxMag = Math.max(...mags);
        if (maxMag > 1.0) {
            return mags.map(val => val / maxMag);
        }
        return mags;
    }

    /**
     * Detect peaks in magnitude array
     */
    getPeaks(mags) {
        const minEnergy = 0.1;
        const howLocal = Math.max(1, Math.floor(mags.length / 25));
        const peaks = [];
        let slope = 0;
        let i = 0;

        // Find initial slope
        while (slope === 0 && i < mags.length - 1) {
            if (mags[i] < mags[i + 1]) {
                slope = 1;
                break;
            } else if (mags[i] > mags[i + 1]) {
                slope = -1;
            }
            i++;
        }

        // Find peaks
        while (i < mags.length - 1) {
            if (slope === 1) {
                if (mags[i] > mags[i + 1]) {
                    if (mags[i] > minEnergy) {
                        if (i > howLocal && i < mags.length - howLocal) {
                            if (this.biggerThanNeighbors(mags, i, howLocal)) {
                                peaks.push(i);
                            }
                        }
                    }
                    slope = -1;
                }
            } else {
                if (mags[i] < mags[i + 1]) {
                    slope = 1;
                }
            }
            i++;
        }

        return peaks;
    }

    /**
     * Check if a value is bigger than neighbors
     */
    biggerThanNeighbors(mags, index, neighbors) {
        for (let i = index - 5; i < index + neighbors; i++) {
            if (i >= 0 && i < mags.length && i !== index) {
                if (mags[index] <= mags[i]) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Check if 3rd peak aligns with target frequency and trigger vibration
     */
    checkThirdPeakAlignment(peaks) {
        if (peaks.length < 3 || this.magnitudes.length === 0) {
            return;
        }

        const thirdPeakIndex = peaks[2];
        const totalBins = this.magnitudes.length;

        // Target frequency: 1700 Hz
        const targetFrequency = 1700;
        const maxFrequency = 4600;
        const targetPosition = targetFrequency / maxFrequency;

        // Calculate 3rd peak's position as fraction
        const peakPosition = thirdPeakIndex / Math.max(totalBins, 1);

        // Check if within tolerance (8% of range)
        const tolerance = 0.08;
        const isHit = Math.abs(peakPosition - targetPosition) < tolerance;

        // Trigger vibration if hit and enough time has passed
        if (isHit) {
            const now = Date.now();
            if (now - this.lastVibrationTime > this.vibrationDebounceMs) {
                this.triggerVibration();
                this.lastVibrationTime = now;
            }
        }
    }

    /**
     * Trigger vibration feedback on mobile browsers
     */
    triggerVibration() {
        // Check if Vibration API is supported
        if (navigator.vibrate) {
            navigator.vibrate(50); // 50ms vibration
        }
    }
}
