
const express = require("express");
const os = require("os");
const path = require("path");
const si = require("systeminformation");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

// Collect processes visible to Linux's ps command.
// This includes processes owned by different users when visible
// under the current user's Linux permissions.
async function getAllProcesses() {
  const { stdout } = await execFileAsync(
    "ps",
    [
      "-eo",
      "pid=,user=,pcpu=,pmem=,stat=,args="
    ],
    {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5000
    }
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // PID, USER, CPU%, MEM%, STATE, COMMAND
      const match = line.match(
        /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*(.*)$/
      );

      if (!match) return null;

      return {
        pid: Number(match[1]),
        user: match[2],
        cpuPercent: Number(match[3]) || 0,
        memoryPercent: Number(match[4]) || 0,
        state: match[5],
        command: match[6] || "unknown"
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.cpuPercent - a.cpuPercent);
}

// Basic health endpoint
app.get("/api/pi/health", (req, res) => {
  res.json({
    status: "ok",
    device: os.hostname(),
    uptimeSeconds: Math.floor(os.uptime())
  });
});

// Live system monitoring endpoint using Server-Sent Events (SSE)
app.get("/api/pi/htop/live", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let connected = true;
  let busy = false;

  res.write("event: connected\ndata: {}\n\n");

  async function sendMetrics() {
    if (!connected || busy) return;

    busy = true;

    try {
      const [cpu, memory, temperature, processes] =
        await Promise.all([
          si.currentLoad(),
          si.mem(),
          si.cpuTemperature(),
          getAllProcesses()
        ]);

      if (!connected) return;

      const data = {
        hostname: os.hostname(),
        platform: os.platform(),
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(os.uptime()),

        cpu: {
          usagePercent: Number(cpu.currentLoad.toFixed(1)),
          cores: cpu.cpus.length,
          temperatureC:
            typeof temperature.main === "number" &&
            temperature.main > 0
              ? temperature.main
              : null
        },

        memory: {
          totalBytes: memory.total,
          usedBytes: memory.used,
          availableBytes: memory.available,
          usagePercent: memory.total
            ? Number(
                ((memory.used / memory.total) * 100).toFixed(1)
              )
            : 0
        },

        swap: {
          totalBytes: memory.swaptotal,
          usedBytes: memory.swapused,
          usagePercent: memory.swaptotal
            ? Number(
                ((memory.swapused / memory.swaptotal) * 100).toFixed(1)
              )
            : 0
        },

        // Number of processes visible to the ps command
        processCount: processes.length,

        // Return every process found, not just the first 30
        processes
      };

      res.write(
        `event: metrics\ndata: ${JSON.stringify(data)}\n\n`
      );
    } catch (error) {
      console.error("Failed to collect metrics:", error.message);

      if (connected) {
        res.write(
          `event: metrics-error\ndata: ${JSON.stringify({
            message: "Unable to collect system metrics"
          })}\n\n`
        );
      }
    } finally {
      busy = false;
    }
  }

  // Send the first reading immediately, then approximately every second
  sendMetrics();

  const timer = setInterval(sendMetrics, 1000);

  // Stop collecting data when the browser disconnects
  res.on("close", () => {
    connected = false;
    clearInterval(timer);
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Health:    http://localhost:${PORT}/api/pi/health`);
  console.log(`Live API:  http://localhost:${PORT}/api/pi/htop/live`);
});
