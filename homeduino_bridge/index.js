const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// --- Configuration (v4.4.0 - Fail-Safe) ---
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

// --- Socket.IO ---
io.on('connection', (socket) => {
    socket.on('add_device', (data) => {
        let { protocol, values, name, uid } = data;
        const topicBase = `homeduino/${protocol}/${uid}`;
        const device = { identifiers: [uid], name: name, model: protocol, manufacturer: "Homeduino", sw_version: "4.4.0" };
        if (values.temperature !== undefined) mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_temp/config`, JSON.stringify({ name: `${name} Temp`, unique_id: `${uid}_temp`, state_topic: `${topicBase}/temperature`, device_class: "temperature", unit_of_measurement: "°C", device }), { retain: true });
        if (values.humidity !== undefined) mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_hum/config`, JSON.stringify({ name: `${name} Hum`, unique_id: `${uid}_hum`, state_topic: `${topicBase}/humidity`, device_class: "humidity", unit_of_measurement: "%", device }), { retain: true });
        if (values.state !== undefined) mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify({ name: name, unique_id: uid, command_topic: `homeduino/command/${protocol}/${uid}`, state_topic: `${topicBase}/state`, device }), { retain: true });
    });
});

// --- Logic ---
if (serial) {
    serial.on('open', () => { setTimeout(() => serial.write('\nRF receive 0\n'), 2000); });
    parser.on('data', (line) => {
        line = line.trim();
        // Sende IMMER raw an GUI, auch wenn kein Protokoll erkannt wird
        io.emit('raw_signal', { raw: line, timestamp: new Date().toISOString() });
        
        if (!line.startsWith('RF receive ')) return;
        try {
            const strSeq = line.split(' ').slice(2).join(' ');
            const info = rfcontrol.prepareCompressedPulses(strSeq);
            if (info) {
                const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                if (results && results.length > 0) {
                    io.emit('signal_group', results.map(res => ({ ...res, groupTimestamp: new Date().toISOString() })));
                } else {
                    io.emit('log', `Raw received but not decodable: ${strSeq}`);
                }
            }
        } catch (e) { io.emit('log', `Error: ${e.message}`); }
    });
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.4.0 (Fail-Safe)'));
