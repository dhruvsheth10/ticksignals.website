/**
 * Resource Monitor - Prevents exceeding Oracle Cloud Always Free tier limits
 * 
 * Free Tier Limits:
 * - CPU: 1 OCPU (monitor usage, stop if > 80%)
 * - Memory: 1 GB (stop if > 900 MB)
 * - Network: 10 TB/month egress (track daily, stop if approaching limit)
 * - Execution time: Max 2 hours per run
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

interface ResourceStats {
    cpuPercent: number;
    memoryMB: number;
    memoryPercent: number;
    networkEgressGB: number;
    uptimeSeconds: number;
}

interface DailyNetworkUsage {
    date: string;
    egressGB: number;
}

const MAX_CPU_PERCENT = 80;
const MAX_MEMORY_MB = 900;
const MAX_MEMORY_PERCENT = 90;
const MAX_NETWORK_EGRESS_TB_MONTH = 10;
const MAX_EXECUTION_TIME_HOURS = 2;
const NETWORK_LOG_FILE = path.join(__dirname, '../data/network-usage.json');

export class ResourceMonitor {
    private startTime: number;
    private networkUsageFile: string;

    constructor() {
        this.startTime = Date.now();
        this.networkUsageFile = NETWORK_LOG_FILE;
        this.ensureNetworkLogDir();
    }

    private ensureNetworkLogDir(): void {
        const logDir = path.dirname(this.networkUsageFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        if (!fs.existsSync(this.networkUsageFile)) {
            fs.writeFileSync(this.networkUsageFile, JSON.stringify([]));
        }
    }

    /**
     * Check if we should continue processing (fail-safe checks)
     */
    async shouldContinue(): Promise<{ continue: boolean; reason?: string }> {
        const stats = await this.getResourceStats();

        // Check CPU
        if (stats.cpuPercent > MAX_CPU_PERCENT) {
            return {
                continue: false,
                reason: `CPU usage too high: ${stats.cpuPercent.toFixed(1)}% (max: ${MAX_CPU_PERCENT}%)`
            };
        }

        // Check Memory
        if (stats.memoryMB > MAX_MEMORY_MB) {
            return {
                continue: false,
                reason: `Memory usage too high: ${stats.memoryMB.toFixed(0)} MB (max: ${MAX_MEMORY_MB} MB)`
            };
        }

        // Check execution time
        const executionHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
        if (executionHours > MAX_EXECUTION_TIME_HOURS) {
            return {
                continue: false,
                reason: `Execution time exceeded: ${executionHours.toFixed(2)} hours (max: ${MAX_EXECUTION_TIME_HOURS} hours)`
            };
        }

        // Check network usage (monthly limit)
        const monthlyEgress = await this.getMonthlyNetworkUsage();
        if (monthlyEgress > MAX_NETWORK_EGRESS_TB_MONTH * 1000) { // Convert TB to GB
            return {
                continue: false,
                reason: `Monthly network egress limit approaching: ${(monthlyEgress / 1000).toFixed(2)} TB (max: ${MAX_NETWORK_EGRESS_TB_MONTH} TB)`
            };
        }

        return { continue: true };
    }

    /**
     * Get current resource statistics
     */
    async getResourceStats(): Promise<ResourceStats> {
        try {
            // Get CPU usage (simplified - use /proc/loadavg as fallback)
            let cpuPercent = 0;
            try {
                const cpuResult = await execAsync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | sed 's/%us,//'");
                cpuPercent = parseFloat(cpuResult.stdout.trim()) || 0;
            } catch {
                // Fallback: estimate from load average
                const loadResult = await execAsync("cat /proc/loadavg | awk '{print $1}'");
                const load = parseFloat(loadResult.stdout.trim()) || 0;
                cpuPercent = Math.min(load * 100, 100); // Rough estimate
            }

            // Get memory usage
            let memoryMB = 0;
            let memoryPercent = 0;
            try {
                const memResult = await execAsync("free -m | grep '^Mem:' | awk '{print $3}'");
                memoryMB = parseFloat(memResult.stdout.trim()) || 0;
                const memTotalResult = await execAsync("free -m | grep '^Mem:' | awk '{print $2}'");
                const memTotalMB = parseFloat(memTotalResult.stdout.trim()) || 1024;
                memoryPercent = (memoryMB / memTotalMB) * 100;
            } catch {
                // Fallback: use /proc/meminfo
                const memInfo = await execAsync("grep MemAvailable /proc/meminfo | awk '{print $2}'");
                const memAvailableKB = parseFloat(memInfo.stdout.trim()) || 0;
                const memTotalInfo = await execAsync("grep MemTotal /proc/meminfo | awk '{print $2}'");
                const memTotalKB = parseFloat(memTotalInfo.stdout.trim()) || 1024000;
                memoryMB = (memTotalKB - memAvailableKB) / 1024;
                memoryPercent = (memoryMB / (memTotalKB / 1024)) * 100;
            }

            // Get uptime
            let uptimeSeconds = 0;
            try {
                const uptimeResult = await execAsync("cat /proc/uptime | awk '{print $1}'");
                uptimeSeconds = parseFloat(uptimeResult.stdout.trim()) || 0;
            } catch {
                // Ignore
            }

            // Network egress (approximate - we'll track our own usage)
            const networkEgressGB = await this.getTodayNetworkUsage();

            return {
                cpuPercent,
                memoryMB,
                memoryPercent,
                networkEgressGB,
                uptimeSeconds
            };
        } catch (error) {
            console.warn('[ResourceMonitor] Error getting stats, using defaults:', error);
            return {
                cpuPercent: 0,
                memoryMB: 0,
                memoryPercent: 0,
                networkEgressGB: 0,
                uptimeSeconds: 0
            };
        }
    }

    /**
     * Log network usage for today
     */
    async logNetworkUsage(egressGB: number): Promise<void> {
        try {
            const today = new Date().toISOString().split('T')[0];
            let usage: DailyNetworkUsage[] = [];

            if (fs.existsSync(this.networkUsageFile)) {
                const content = fs.readFileSync(this.networkUsageFile, 'utf-8');
                usage = JSON.parse(content);
            }

            const todayIndex = usage.findIndex(u => u.date === today);
            if (todayIndex >= 0) {
                usage[todayIndex].egressGB += egressGB;
            } else {
                usage.push({ date: today, egressGB });
            }

            // Keep only last 31 days
            usage = usage.slice(-31);

            fs.writeFileSync(this.networkUsageFile, JSON.stringify(usage, null, 2));
        } catch (error) {
            console.error('[ResourceMonitor] Error logging network usage:', error);
        }
    }

    /**
     * Get today's network usage in GB
     */
    private async getTodayNetworkUsage(): Promise<number> {
        try {
            const today = new Date().toISOString().split('T')[0];
            if (fs.existsSync(this.networkUsageFile)) {
                const content = fs.readFileSync(this.networkUsageFile, 'utf-8');
                const usage: DailyNetworkUsage[] = JSON.parse(content);
                const todayUsage = usage.find(u => u.date === today);
                return todayUsage ? todayUsage.egressGB : 0;
            }
            return 0;
        } catch {
            return 0;
        }
    }

    /**
     * Get monthly network usage in GB
     */
    private async getMonthlyNetworkUsage(): Promise<number> {
        try {
            if (fs.existsSync(this.networkUsageFile)) {
                const content = fs.readFileSync(this.networkUsageFile, 'utf-8');
                const usage: DailyNetworkUsage[] = JSON.parse(content);
                // Sum last 30 days
                return usage.slice(-30).reduce((sum, u) => sum + u.egressGB, 0);
            }
            return 0;
        } catch {
            return 0;
        }
    }

    /**
     * Print current resource stats
     */
    async printStats(): Promise<void> {
        const stats = await this.getResourceStats();
        const executionHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
        const monthlyEgress = await this.getMonthlyNetworkUsage();

        console.log('\n📊 Resource Monitor Stats:');
        console.log(`   CPU: ${stats.cpuPercent.toFixed(1)}% (max: ${MAX_CPU_PERCENT}%)`);
        console.log(`   Memory: ${stats.memoryMB.toFixed(0)} MB / ${MAX_MEMORY_MB} MB (${stats.memoryPercent.toFixed(1)}%)`);
        console.log(`   Execution Time: ${executionHours.toFixed(2)} hours (max: ${MAX_EXECUTION_TIME_HOURS} hours)`);
        console.log(`   Network (Today): ${stats.networkEgressGB.toFixed(2)} GB`);
        console.log(`   Network (Month): ${(monthlyEgress / 1000).toFixed(2)} TB / ${MAX_NETWORK_EGRESS_TB_MONTH} TB`);
    }
}

