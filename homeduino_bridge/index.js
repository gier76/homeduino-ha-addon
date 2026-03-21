const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// --- Configuration (v4.4.1 - Serial Debug) ---
let options = { serial_port: "/dev/ttyUSB0", baud_rate: 115200, mqtt_broker: "core-mosquitto", mqtt_port: 1883, mqtt_user: "", mqtt_password: "", debug: true };
if (fs.existsSync('/data/options.json')) {
    try { options = { ...options, ...JSON.parse(fs.readFileSync('/data/options.json', 'utf8')) }; } catch (e) { console.error(e); }
}

let serial;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
} catch (err) { console.error(err); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" }, transports: ["polling", "websocket"] });
app.use(express.static(path.join(__dirname, 'public')));

// --- Serial Debug ---
if (serial) {
    serial.on('open', () => { 
        console.log('Serial Port Open'); 
        setTimeout(() => serial.write('\nRF receive 0\n'), 2000); 
    });
    
    // Low-level debugging
    serial.on('data', (data) => {
        const raw = data.toString();
        console.log('[RAW SERIAL DATA]:', raw);
        io.emit('log', `Raw Serial: ${raw}`);
    });
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.4.1 (Serial Debug)'));
