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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" }, transports: ["polling", "websocket"] });
app.use(express.static(path.join(__dirname, 'public')));

const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { username: options.mqtt_user, password: options.mqtt_password });

// --- Robust Signal Buffer ---
let serial;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
} catch (err) { console.error(err); }

if (serial) {
    serial.on('open', () => { 
        setInterval(() => serial.write('RF receive 0\n'), 5000); 
    });
    
    let buffer = '';
    serial.on('data', (data) => {
        buffer += data.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop();
        for (let line of lines) {
            line = line.trim();
            if (line.includes('RF receive ') || line.match(/^[012\s]+$/)) {
                processSignal(line);
            }
        }
    });
}

function processSignal(line) {
    try {
        if (!line.startsWith('RF receive ')) return;
        const strSeq = line.split(' ').slice(2).join(' ');
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        if (info) {
            const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
            if (results && results.length > 0) {
                const enriched = results.map(res => {
                    res.values.raw = strSeq.split(' ').pop();
                    const uid = 'hd_' + res.protocol + '_' + (res.values.id || 'fixed');
                    Object.keys(res.values).forEach(k => {
                        if (k !== 'raw') mqttClient.publish(`homeduino/${res.protocol}/${uid}/${k}`, res.values[k].toString(), { retain: true });
                    });
                    return { ...res, uid, groupTimestamp: new Date().toISOString() };
                });
                io.emit('signal_group', enriched);
            }
        }
    } catch (e) { console.error('Parse Error:', e); }
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v5.0.0 (Entry point changed)'));
