// @ts-nocheck
const os = require('os');
const { execSync } = require('child_process');

/**
 * ResourceMonitor — Shared utility for checking GPU+VRAM+CPU system load.
 *
 * Used by BackgroundMemoryDaemon and BackgroundWorkflowScheduler
 * to gate background work behind a resource threshold.
 *
 * CPU measurement uses delta-sampling (two readings 1s apart) for accuracy.
 */
class ResourceMonitor {
    constructor(threshold = 20) {
        this.threshold = threshold; // percentage
        this._lastCpuTimes = null;
    }

    /**
     * Check if system resources are available for background work.
     * Returns { available: bool, cpu: number, gpu: number, vram: number, combined: number }
     */
    async check() {
        const cpu = await this._getCpuLoad();
        const { gpu, vram } = this._getGpuLoad();

        // Combined = max of all three signals
        const combined = Math.max(cpu, gpu, vram);

        return {
            available: combined < this.threshold,
            cpu: Math.round(cpu),
            gpu: Math.round(gpu),
            vram: Math.round(vram),
            combined: Math.round(combined),
        };
    }

    /**
     * CPU load via delta-sampling os.cpus() times.
     * First call returns 0 (no baseline), subsequent calls return accurate %.
     */
    async _getCpuLoad() {
        try {
            const cpus = os.cpus();
            const current = {
                idle: cpus.reduce((sum, c) => sum + c.times.idle, 0),
                total: cpus.reduce((sum, c) =>
                    sum + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle, 0),
            };

            if (!this._lastCpuTimes) {
                // First call — store baseline, return 0 (assume idle)
                this._lastCpuTimes = current;
                return 0;
            }

            const idleDelta = current.idle - this._lastCpuTimes.idle;
            const totalDelta = current.total - this._lastCpuTimes.total;

            this._lastCpuTimes = current;

            if (totalDelta === 0) return 0;
            return 100 - (idleDelta / totalDelta * 100);
        } catch (e) {
            return 0; // Can't measure = assume free
        }
    }

    /**
     * GPU + VRAM load via nvidia-smi (Windows/Linux).
     * Returns { gpu: number (%), vram: number (%) }.
     * Falls back to { gpu: 0, vram: 0 } if no NVIDIA GPU.
     */
    _getGpuLoad() {
        try {
            const output = execSync(
                'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
                { timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            const parts = output.trim().split(',').map(s => parseFloat(s.trim()));
            if (parts.length >= 3 && !isNaN(parts[0])) {
                return {
                    gpu: parts[0],
                    vram: (parts[1] / parts[2]) * 100,
                };
            }
        } catch (e) {
            // No NVIDIA GPU or nvidia-smi not available
        }
        return { gpu: 0, vram: 0 };
    }
}

module.exports = ResourceMonitor;
