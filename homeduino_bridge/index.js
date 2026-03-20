const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// --- Configuration Handling ---
// MOVED TO TOP to be available for MQTT setup
let options = {
    serial_port: "/dev/ttyUSB0",
    baud_rate: 115200,
    mqtt_broker: "core-mosquitto",
    mqtt_port: 1883,
    mqtt_user: "",
    mqtt_password: "",
    debug: false
};

if (fs.existsSync('/data/options.json')) {
    try {
        const userOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        options = { ...options, ...userOptions };
        console.log("Loaded options:", JSON.stringify(options));
    } catch (e) {
        console.error("Failed to parse /data/options.json", e);
    }
}

// --- Serial Port Setup ---
const serialPortPath = options.serial_port;
const serial = new SerialPort({ path: serialPortPath, baudRate: parseInt(options.baud_rate) });
const parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));

// --- Web Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    path: '/socket.io',
    cors: { origin: "*" } 
});

// Serve static files from 'public' directory
const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    console.error(`Error: Public directory not found at ${publicPath}`);
    // Fallback: Create directory and index.html if missing
    fs.mkdirSync(publicPath, { recursive: true });
    fs.writeFileSync(path.join(publicPath, 'index.html'), `
<!DOCTYPE html>
<html>
<head><title>Homeduino Bridge</title></head>
<body>
<h1>Homeduino Bridge Connected</h1>
<div id="log"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io({path: '/socket.io'});
  socket.on('connect', () => { document.getElementById('log').innerHTML += '<div>Connected</div>'; });
  socket.on('signal', (data) => { 
      document.getElementById('log').innerHTML += '<div>' + JSON.stringify(data) + '</div>'; 
  });
</script>
</body>
</html>`);
}

app.use(express.static(publicPath));

// Explicit route for root
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// --- MQTT Setup ---
const mqttOptions = {
    username: options.mqtt_user,
    password: options.mqtt_password
};
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, mqttOptions);
mqttClient.on('connect', () => console.log('MQTT Connected'));
mqttClient.on('error', (err) => console.error('MQTT Error:', err.message));

// --- Logic ---
serial.on('open', () => {
    console.log(`Serial connected on ${serialPortPath}. Flushing buffer...`);
    serial.write('\nRF receive 0\n');
});

serial.on('error', (err) => {
    console.error('Serial Error:', err.message);
});

parser.on('data', (line) => {
    console.log('Raw:', line);
    if (line.startsWith('RF receive ')) {
        try {
            const parts = line.split(' ');
            const strSeq = parts.slice(2).join(' ');
            const info = rfcontrol.prepareCompressedPulses(strSeq);
            if (info) {
                const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                if (results && results.length > 0) {
                    console.log('Decoded:', JSON.stringify(results));
                    io.emit('signal', results);
                    
                    results.forEach(res => {
                        mqttClient.publish(`homeduino/rf/${res.protocol}`, JSON.stringify(res.values), { retain: false });
                    });
                }
            }
        } catch (e) {
            console.error('Decode Error:', e.message);
        }
    }
});

server.listen(8080, '0.0.0.0', () => {
    console.log('Bridge Server listening on port 8080');
});
