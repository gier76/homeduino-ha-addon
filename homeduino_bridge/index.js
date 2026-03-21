const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- Configuration (v4.2.0) ---
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

// --- Helpers ---
function generateSecureHash(str) { return crypto.createHash('md5').update(str).digest('hex').substring(0, 10); }

function constructDeviceIdentity(protocol, values) {
    let parts = [];
    if (values.id !== undefined) parts.push(`id-${values.id}`);
    if (values.systemcode !== undefined) parts.push(`sys-${values.systemcode}`);
    if (values.unitcode !== undefined) parts.push(`unit-${values.unitcode}`);
    if (values.channel !== undefined) parts.push(`ch-${values.channel}`);
    let idSuffix = parts.join('_') || `raw_${generateSecureHash(values.raw || '')}`;
    return { uid: `hd_${protocol}_${idSuffix}`.replace(/[^a-z0-9_-]/gi, '_').toLowerCase(), name: `${protocol} ${parts.join(' ')}`.trim() || `${protocol} Unknown` };
}

// --- Socket.IO ---
io.on('connection', (socket) => {
    socket.on('add_device', (data) => {
        let { protocol, values, name, uid } = data;
        const topicBase = `homeduino/${protocol}/${uid}`;
        const device = { identifiers: [uid], name: name, model: protocol, manufacturer: "Homeduino", sw_version: "4.2.0" };
        if (values.temperature !== undefined) mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_temp/config`, JSON.stringify({ name: `${name} Temp`, unique_id: `${uid}_temp`, state_topic: `${topicBase}/temperature`, device_class: "temperature", unit_of_measurement: "°C", device }), { retain: true });
        if (values.humidity !== undefined) mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_hum/config`, JSON.stringify({ name: `${name} Hum`, unique_id: `${uid}_hum`, state_topic: `${topicBase}/humidity`, device_class: "humidity", unit_of_measurement: "%", device }), { retain: true });
        if (values.state !== undefined) mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify({ name: name, unique_id: uid, command_topic: `homeduino/command/${protocol}/${uid}`, state_topic: `${topicBase}/state`, device }), { retain: true });
    });

    socket.on('send_command', (data) => {
        const { protocol, values } = data;
        console.log(`[SWITCH DEBUG] Protocol: ${protocol}, Values: ${JSON.stringify(values)}`);
        try {
            const result = rfcontrol.encodeMessage(protocol, values);
            if (result && serial && serial.isOpen) {
                const cmd = `RF send 4 ${result.pulseLengths.length} ${result.pulseLengths.join(' ')} ${result.pulses}`;
                console.log(`[SWITCH DEBUG] Raw Command: ${cmd}`);
                serial.write(cmd + '\n');
            }
        } catch (e) { console.error('Encode Error:', e.message); }
    });
});

// --- Logic ---
if (serial) {
    serial.on('open', () => { setTimeout(() => serial.write('\nRF receive 0\n'), 2000); });
    parser.on('data', (line) => {
        if (!line.startsWith('RF receive ')) return;
        try {
            const strSeq = line.split(' ').slice(2).join(' ');
            const info = rfcontrol.prepareCompressedPulses(strSeq);
            if (info) {
                const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                if (results && results.length > 0) {
                    console.log(`[DEBUG] Raw Signal: ${strSeq}`);
                    console.log(`[DEBUG] Decoded: ${JSON.stringify(results)}`);
                    const enriched = results.map(res => {
                        res.values.raw = strSeq.split(' ').pop();
                        const identity = constructDeviceIdentity(res.protocol, res.values);
                        const uid = identity.uid;
                        const topicBase = `homeduino/${res.protocol}/${uid}`;
                        
                        Object.keys(res.values).forEach(k => {
                            if (k !== 'raw') mqttClient.publish(`${topicBase}/${k}`, res.values[k].toString(), { retain: true });
                        });
                        
                        return { ...res, uid, identityName: identity.name, groupTimestamp: new Date().toISOString() };
                    });
                    io.emit('signal_group', enriched);
                }
            }
        } catch (e) { console.error(e); }
    });
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.2.0'));
