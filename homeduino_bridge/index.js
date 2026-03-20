const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// --- Configuration Handling (v3.8.7) ---
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
const serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
const parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));

// --- Web Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    path: '/socket.io',
    cors: { origin: "*" },
    transports: ["polling", "websocket"] // Allow both, but client prefers polling now
});

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
}
app.use(express.static(publicPath));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// --- MQTT Setup ---
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, {
    username: options.mqtt_user,
    password: options.mqtt_password
});

mqttClient.on('connect', () => {
    console.log('MQTT Connected');
    mqttClient.subscribe('homeduino/command/#');
    io.emit('mqtt_status', { connected: true, broker: options.mqtt_broker });
});

mqttClient.on('error', (err) => console.error('MQTT Error:', err.message));

// --- Auto-Discovery Cache ---
const discoveredDevices = new Set();

function sendDiscovery(protocol, uid, values) {
    if (discoveredDevices.has(uid)) return;

    const topicBase = `homeduino/${protocol}/${uid}`;
    const device = {
        identifiers: [uid],
        name: `${protocol} ${uid}`,
        model: protocol,
        manufacturer: "Homeduino"
    };

    console.log(`Sending Auto-Discovery for ${uid}`);

    // Temperature Sensor
    if (values.temperature !== undefined) {
        mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_temp/config`, JSON.stringify({
            name: `${protocol} ${uid} Temperature`,
            unique_id: `${uid}_temp`,
            state_topic: `${topicBase}/temperature`,
            device_class: "temperature",
            unit_of_measurement: "°C",
            value_template: "{{ value }}",
            device: device
        }), { retain: true });
    }

    // Humidity Sensor
    if (values.humidity !== undefined) {
        mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_hum/config`, JSON.stringify({
            name: `${protocol} ${uid} Humidity`,
            unique_id: `${uid}_hum`,
            state_topic: `${topicBase}/humidity`,
            device_class: "humidity",
            unit_of_measurement: "%",
            value_template: "{{ value }}",
            device: device
        }), { retain: true });
    }
    
    // Battery Sensor
    if (values.battery !== undefined) {
         mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_bat/config`, JSON.stringify({
            name: `${protocol} ${uid} Battery`,
            unique_id: `${uid}_bat`,
            state_topic: `${topicBase}/battery`,
            device_class: "battery",
            unit_of_measurement: "%",
            value_template: "{{ value }}",
            device: device
        }), { retain: true });
    }

    // Switch
    if (values.state !== undefined) {
         mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify({
            name: `${protocol} ${uid}`,
            unique_id: uid,
            command_topic: `homeduino/command/${protocol}/${uid}`,
            state_topic: `${topicBase}/state`,
            payload_on: "true",
            payload_off: "false",
            device: device
        }), { retain: true });
    }

    discoveredDevices.add(uid);
}

// --- Logic ---
serial.on('open', () => {
    console.log(`Serial connected on ${options.serial_port}`);
    setTimeout(() => serial.write('\nRF receive 0\n'), 2000);
});

parser.on('data', (line) => {
    if (options.debug) console.log('Raw:', line);
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
                        // Improved UID generation: Use id and/or channel. Fallback to a small hash of the raw sequence if no ID is found.
                        let idSuffix = res.values.id !== undefined ? res.values.id : '';
                        if (res.values.channel !== undefined) idSuffix += (idSuffix ? '_' : '') + 'ch' + res.values.channel;
                        if (!idSuffix) {
                            // Last resort: simple hash of the pulse sequence to distinguish sensors without IDs
                            idSuffix = 'raw_' + strSeq.split(' ').slice(-1)[0].substring(0, 8); 
                        }
                        
                        const uid = `hd_${res.protocol}_${idSuffix}`;
                        const topicBase = `homeduino/${res.protocol}/${uid}`;
                        
                        // 1. Send Auto-Discovery (if new)
                        sendDiscovery(res.protocol, uid, res.values);

                        // 2. Publish State
                        Object.keys(res.values).forEach(key => {
                            const val = res.values[key];
                            mqttClient.publish(`${topicBase}/${key}`, val.toString(), { retain: true });
                        });
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
