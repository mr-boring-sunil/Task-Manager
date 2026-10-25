const express = require("express");
const os = require("os");
const si = require("systeminformation");

const app = express();
const PORT = 3000;

app.get("/api/pi/live", async (req, res) => {
  // Keep the HTTP connection open for live updates.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let connected = true;
  let busy = false;

  // Tell the client the connection is established.
  res.write("event: connected\ndata: {}\n\n");

  async function sendPiData() {
    if (!connected || busy) return;
    busy = true;

    try {
      const [load, memory, temp, fs] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.cpuTemperature(),
        si.fsSize()
      ]);

      if (!connected) return;

      const data = {
        device: os.hostname(),
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(os.uptime()),
        cpu: {
          usagePercent: Number(load.currentLoad.toFixed(2)),
          temperatureC:
            typeof temp.main === "number" && temp.main > 0
              ? temp.main
              : null
        },
        memory: {
          totalBytes: memory.total,
          usedBytes: memory.used,
          usagePercent: Number(
            ((memory.used / memory.total) * 100).toFixed(2)
          )
        },
        disks: fs.map(disk => ({
          filesystem: disk.fs,
          mount: disk.mount,
          usagePercent: disk.use
        }))
      };

      // SSE message: event name + JSON data.
      res.write(`event: pi-data\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      if (connected) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message: "Failed to collect Pi metrics"
          })}\n\n`
        );
      }
    } finally {
      busy = false;
    }
  }

  // Send the first reading immediately.
  sendPiData();

  // Then stream new readings approximately every second.
  const timer = setInterval(sendPiData, 1000);

  // Stop work when the client disconnects.
  req.on("close", () => {
    connected = false;
    clearInterval(timer);
  });
});

app.get("/api/pi/health", (req, res) => {
  res.json({ status: "ok", device: os.hostname() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Pi live API listening on port ${PORT}`);
});