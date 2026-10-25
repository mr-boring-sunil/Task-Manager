
const express = require("express");
const os = require("os");
const path = require("path");
const si = require("systeminformation");

const app = express();
const PORT = 3000;

// Serve the frontend from the public directory.
app.use(express.static(path.join(__dirname, "public")));

// Health-check endpoint.
app.get("/api/pi/health", (req, res) => {
  res.json({
    status: "ok",
    device: os.hostname(),
    uptimeSeconds: Math.floor(os.uptime())
  });
});

// Live system-monitoring endpoint using Server-Sent Events.
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
      const [cpu, memory, temperature, processData] =
        await Promise.all([
          si.currentLoad(),
          si.mem(),
          si.cpuTemperature(),
          si.processes()
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

        processCount: processData.all,

        processes: processData.list
          .sort((a, b) => (b.cpu || 0) - (a.cpu || 0))
          .slice(0, 30)
          .map(process => ({
            pid: process.pid,
            user: process.user || "unknown",
            cpuPercent: Number((process.cpu || 0).toFixed(1)),
            memoryPercent: Number((process.mem || 0).toFixed(1)),
            state: process.state || "unknown",
            command: process.command || process.name || "unknown"
          }))
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

  // Send the first reading immediately.
  sendMetrics();

  // Send new readings approximately every second.
  const timer = setInterval(sendMetrics, 1000);

  // Stop the timer when this browser connection closes.
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
