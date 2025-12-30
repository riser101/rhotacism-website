/**
 * WaveformCanvas
 *
 * Renders a real-time spectrogram visualization using HTML5 Canvas API.
 * Displays waveform, peaks, and target frequency line.
 */

class WaveformCanvas {
    constructor(canvasElement) {
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');

        // Set canvas resolution for crisp rendering
        const rect = this.canvas.getBoundingClientRect();
        // Use fallback dimensions if element is hidden or has zero size
        const width = rect.width > 0 ? rect.width : 400;
        const height = rect.height > 0 ? rect.height : 150;
        this.canvas.width = width * window.devicePixelRatio;
        this.canvas.height = height * window.devicePixelRatio;
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        // Colors - Medical Grade Design
        this.colors = {
            waveform: '#FFFFFF',
            peaks: 'rgba(255, 255, 255, 0.6)',
            targetLine: '#FFB300', // Amber orange
            targetLabel: '#FFB300', // Amber orange
            freqLabel: '#FFFFFF',
            freqLabelOpacity: 0.3
        };

        // Target frequency (configurable: 1700 Hz for male, 2000 Hz for female)
        this.targetFrequency = 1700;

        // Data
        this.magnitudes = [];
        this.peaks = [];

        // Rendering
        this.animationFrameId = null;
        this.shouldRender = true;

        // Initial render to show target line
        this.scheduleRender();
    }

    /**
     * Update magnitudes data and schedule render
     */
    setMagnitudes(magnitudes) {
        this.magnitudes = magnitudes;
        this.scheduleRender();
    }

    /**
     * Update peaks data and schedule render
     */
    setPeaks(peaks) {
        this.peaks = peaks;
    }

    /**
     * Set target frequency and re-render
     */
    setTargetFrequency(frequency) {
        this.targetFrequency = frequency;
        this.scheduleRender();
    }

    /**
     * Schedule a render on next animation frame
     */
    scheduleRender() {
        if (this.animationFrameId === null) {
            this.animationFrameId = requestAnimationFrame(() => {
                this.render();
                this.animationFrameId = null;
            });
        }
    }

    /**
     * Main render function
     */
    render() {
        if (!this.shouldRender) return;

        const rect = this.canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // Clear canvas
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0)';
        this.ctx.clearRect(0, 0, width, height);

        // Draw waveform
        this.drawWaveform(width, height);

        // Draw target line and label
        this.drawTargetLine(width, height);

        // Draw peaks
        this.drawPeaks(width, height);

        // Draw frequency scale labels
        this.drawFrequencyScale(width, height);
    }

    /**
     * Draw the waveform line
     */
    drawWaveform(width, height) {
        if (this.magnitudes.length === 0) return;

        const mags = this.magnitudes;
        const stepX = width / (mags.length - 1 || 1);

        this.ctx.strokeStyle = this.colors.waveform;
        this.ctx.lineWidth = 2;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.ctx.beginPath();

        // Start at first point
        let firstY = height - (mags[0] * height);
        this.ctx.moveTo(0, firstY);

        // Draw line through all points
        for (let i = 1; i < mags.length; i++) {
            const x = i * stepX;
            const y = height - (mags[i] * height);
            this.ctx.lineTo(x, y);
        }

        this.ctx.stroke();
    }

    /**
     * Draw the target frequency line
     */
    drawTargetLine(width, height) {
        const maxFrequency = 4600;
        const targetPosition = this.targetFrequency / maxFrequency;
        const targetX = targetPosition * width;

        // Draw line
        this.ctx.strokeStyle = this.colors.targetLine;
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.moveTo(targetX, 0);
        this.ctx.lineTo(targetX, height);
        this.ctx.stroke();

        // Draw target label box
        const labelText = `${Math.round(this.targetFrequency)} Hz`;
        const labelPadding = 4;
        const labelHeight = 16;
        const labelY = Math.max(30, 10);

        // Measure text
        this.ctx.font = '10px Arial';
        const textMetrics = this.ctx.measureText(labelText);
        const textWidth = textMetrics.width;

        // Draw label box
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        this.ctx.fillRect(
            targetX - textWidth / 2 - labelPadding,
            labelY - labelHeight / 2 - labelPadding,
            textWidth + labelPadding * 2,
            labelHeight + labelPadding
        );

        // Draw label text
        this.ctx.fillStyle = this.colors.targetLabel;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.font = '10px Arial';
        this.ctx.fillText(labelText, targetX, labelY);
    }

    /**
     * Draw peak indicators
     */
    drawPeaks(width, height) {
        if (this.peaks.length === 0 || this.magnitudes.length === 0) return;

        const mags = this.magnitudes;
        const stepX = width / (mags.length - 1 || 1);

        this.ctx.strokeStyle = this.colors.peaks;
        this.ctx.lineWidth = 2;

        for (const peakIndex of this.peaks) {
            if (peakIndex < 0 || peakIndex >= mags.length) continue;

            const x = peakIndex * stepX;
            const peakHeight = mags[peakIndex] * height;
            const y = height - peakHeight;

            // Draw vertical line from bottom to peak
            this.ctx.beginPath();
            this.ctx.moveTo(x, height);
            this.ctx.lineTo(x, y);
            this.ctx.stroke();
        }
    }

    /**
     * Draw frequency scale labels
     */
    drawFrequencyScale(width, height) {
        this.ctx.fillStyle = `rgba(255, 255, 255, ${this.colors.freqLabelOpacity})`;
        this.ctx.font = '10px Arial';
        this.ctx.textBaseline = 'top';

        // 0 Hz (left)
        this.ctx.textAlign = 'left';
        this.ctx.fillText('0 Hz', 4, height - 16);

        // 2300 Hz (center)
        this.ctx.textAlign = 'center';
        this.ctx.fillText('2300 Hz', width / 2, height - 16);

        // 4600 Hz (right)
        this.ctx.textAlign = 'right';
        this.ctx.fillText('4600 Hz', width - 4, height - 16);
    }

    /**
     * Resize canvas to match element size
     */
    resize() {
        const rect = this.canvas.getBoundingClientRect();
        // Only resize if we have valid dimensions
        if (rect.width > 0 && rect.height > 0) {
            this.canvas.width = rect.width * window.devicePixelRatio;
            this.canvas.height = rect.height * window.devicePixelRatio;
            this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        }
        this.scheduleRender();
    }

    /**
     * Start continuous rendering
     */
    startRendering() {
        this.shouldRender = true;
    }

    /**
     * Stop continuous rendering
     */
    stopRendering() {
        this.shouldRender = false;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.stopRendering();
    }
}
