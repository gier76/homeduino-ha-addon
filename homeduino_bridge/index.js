const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

let options = { serial_port: "/dev/ttyUSB0", baud_rate: 115200, mqtt_broker: "core-mosquitto", mqtt_port: 1883, mqtt_user: "", mqtt_password: "", debug: true };
if (fs.existsSync('/data/options.json')) {
    try { options = { ...options, ...JSON.parse(fs.readFileSync('/data/options.json', 'utf8')) }; } catch (e) { console.error(e); }
}

let serial, parser;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
    parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
} catch (err) { console.error(err); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" }, transports: ["polling", "websocket"] });
app.use(express.static(path.join(__dirname, 'public')));
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { username: options.mqtt_user, password: options.mqtt_password });

// --- Robust Buffer ---
let buffer = '';
if (serial) {
    serial.on('open', () => { 
        console.log('Serial Port Open');
        setTimeout(() => serial.write('\nRF receive 0\n'), 2000); 
    });
    
    parser.on('data', (line) => {
        line = line.trim();
        if (!line) return;
        
        // Puffer-Logik
        if (line.startsWith('RF receive')) {
            buffer = line;
        } else if (buffer.startsWith('RF receive')) {
            buffer += line;
        }

        // Wenn das Paket vollständig ist (endet auf '03' bei weather2)
        if (buffer.startsWith('RF receive') && buffer.endsWith('03')) {
            processSignal(buffer);
            buffer = '';
        }
    });
}

function processSignal(line) {
    try {
        const parts = line.split(' ');
        const strSeq = parts.slice(2).join(' ');
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        if (info) {
            const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
            if (results && results.length > 0) {
                const enriched = results.map(res => {
                    res.values.raw = strSeq.split(' ').pop();
                    return { ...res, groupTimestamp: new Date().toISOString() };
                });
                io.emit('signal_group', enriched);
            }
        }
    } catch (e) { console.error('Parse Error:', e); }
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.6.2 (Buffer Fix)'));
