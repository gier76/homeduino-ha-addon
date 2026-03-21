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

let serial;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
} catch (err) { console.error(err); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" }, transports: ["polling", "websocket"] });
app.use(express.static(path.join(__dirname, 'public')));

const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { username: options.mqtt_user, password: options.mqtt_password });

// --- Humidity Decoder (v4.8.2) ---
function extractHumidity(bits) {
    if (!bits || bits.length < 50) return null;
    try {
        const humBits = bits.substring(40, 48).replace(/2/g, '1');
        const hum = parseInt(humBits, 2);
        return (hum > 0 && hum <= 100) ? hum : null;
    } catch(e) { return null; }
}

// --- Serial Handler ---
if (serial) {
    serial.on('open', () => { 
        setInterval(() => serial.write('RF receive 0\n'), 5000); 
    });
    
    serial.on('data', (data) => {
        const ascii = data.toString('ascii');
        // Simple line buffering
        if (ascii.includes('RF receive')) {
             // ... parsing logic here
        }
    });

    serial.on('error', (err) => {
        console.error('Serial Error:', err.message);
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
                    const bitStream = strSeq.split(' ').pop();
                    res.values.raw = bitStream;
                    if (res.protocol === 'weather2' && res.values.humidity === undefined) {
                        const hum = extractHumidity(bitStream);
                        if (hum) res.values.humidity = hum;
                    }
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

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.8.2 (MQTT Fixed)'));
