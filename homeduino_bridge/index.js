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

// --- Configuration Handling (v3.9.5) ---
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
let serial, parser;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
    parser = serial.pipe(new ReadlineParser({ delimiter: '
' }));
} catch (err) {
    console.error("Serial Port Error:", err.message);
}

// --- Web Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    path: '/socket.io',
    cors: { origin: "*" },
    transports: ["polling", "websocket"]
});

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// --- MQTT Setup ---
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, {
    username: options.mqtt_user,
    password: options.mqtt_password
});

mqttClient.on('connect', () => console.log('MQTT Connected'));

// --- Helper for Robust Hash ---
function generateSecureHash(str) {
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 10);
}

// --- Helper to construct a better name/ID ---
function constructDeviceIdentity(protocol, values) {
    const bitStream = values.raw || '';
    const rawHash = generateSecureHash(bitStream);
    let parts = [];
    
    if (values.id !== undefined) parts.push(`id-${values.id}`);
    if (values.address !== undefined) parts.push(`addr-${values.address}`);
    if (values.systemcode !== undefined) parts.push(`sys-${values.systemcode}`);
    if (values.unitcode !== undefined) parts.push(`unit-${values.unitcode}`);
    if (values.unit !== undefined) parts.push(`unit-${values.unit}`);
    if (values.channel !== undefined) parts.push(`ch-${values.channel}`);
    if (values.house !== undefined) parts.push(`house-${values.house}`);

    let idSuffix = parts.join('_') || `raw_${rawHash}`;

    const uid = `hd_${protocol}_${idSuffix}`.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const name = `${protocol} ${parts.join(' ')}`.trim() || `${protocol} Unknown ${rawHash.substring(0,4)}`;

    return { uid, name, idSuffix };
}

// --- Manual Discovery Logic ---
function sendDiscovery(protocol, uid, values, friendlyName) {
    if (!uid) return;
    const topicBase = `homeduino/${protocol}/${uid}`;
    const device = {
        identifiers: [uid],
        name: friendlyName,
        model: `${protocol} (${uid.split('_').pop()})`,
        manufacturer: "Homeduino (rfcontroljs)",
        sw_version: "3.9.5"
    };

    console.log(`[DISCOVERY] Registering ${uid} as "${device.name}"`);

    // Define sensor types and their properties
    const sensorTypes = {
        temperature: { class: "temperature", unit: "°C" },
        humidity: { class: "humidity", unit: "%" },
        battery: { class: "battery", unit: "%" },
        pressure: { class: "pressure", unit: "hPa" },
        raining: { class: "moisture", unit: "mm" } // Using moisture for rain
    };

    for (const [key, config] of Object.entries(sensorTypes)) {
        if (values[key] !== undefined) {
            mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_${key}/config`, JSON.stringify({
                name: `${device.name} ${key.charAt(0).toUpperCase() + key.slice(1)}`,
                unique_id: `${uid}_${key}`,
                state_topic: `${topicBase}/${key}`,
                device_class: config.class,
                unit_of_measurement: config.unit,
                value_template: "{{ value }}",
                device: device
            }), { retain: true });
        }
    }

    // Switch
    if (values.switch || values.command || values.state !== undefined) {
         mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify({
            name: device.name,
            unique_id: uid,
            command_topic: `homeduino/command/${protocol}/${uid}`,
            state_topic: `${topicBase}/state`,
            payload_on: "true",
            payload_off: "false",
            device: device
        }), { retain: true });
    }
}

// --- Socket.IO Interaction ---
io.on('connection', (socket) => {
    socket.on('add_device', (data) => {
        let { protocol, values, name, uid } = data;
        if (!name) { // Fallback name generation
             const identity = constructDeviceIdentity(protocol, values);
             name = identity.name;
             uid = identity.uid;
        }
        sendDiscovery(protocol, uid, values, name);
    });

    socket.on('send_command', (data) => {
        const { protocol, values } = data;
        try {
            const result = rfcontrol.encodeMessage(protocol, values);
            if (result && serial && serial.isOpen) {
                const cmd = `RF send 4 ${result.pulseLengths.length} ${result.pulseLengths.join(' ')} ${result.pulses}`;
                serial.write(cmd + '
');
            }
        } catch (e) {
            console.error('Encode Error:', e.message);
        }
    });
});

// --- Logic ---
if (serial) {
    serial.on('open', () => {
        io.emit('status', { connected: true });
        setTimeout(() => serial.write('
RF receive 0
'), 2000);
    });

    const receivedHashes = new Set();

    parser.on('data', (line) => {
        line = line.trim();
        if (options.debug && line.startsWith('RF receive')) console.log('Raw:', line);
        
        if (line.startsWith('RF receive ')) {
            try {
                const parts = line.split(' ');
                const strSeq = parts.slice(2).join(' ');
                const info = rfcontrol.prepareCompressedPulses(strSeq);
                
                if (info) {
                    const pulseStr = parts.slice(-1)[0]; 
                    const rawHash = generateSecureHash(pulseStr);
                    
                    // Debounce: Only process new unique signals
                    if (receivedHashes.has(rawHash)) return;
                    receivedHashes.add(rawHash);
                    setTimeout(() => receivedHashes.delete(rawHash), 5000); // Allow re-processing after 5s

                    // **** NEW: Try to decode with ALL protocols ****
                    const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                    
                    if (results && results.length > 0) {
                        console.log(`[DECODE] Found ${results.length} potential protocols for hash ${rawHash}`);
                        
                        const groupTimestamp = new Date().toISOString();
                        const enrichedResults = results.map(res => {
                            res.values.raw = pulseStr; // Inject raw pulse string
                            const identity = constructDeviceIdentity(res.protocol, res.values);
                            const uid = identity.uid;
                            const topicBase = `homeduino/${res.protocol}/${uid}`;

                            // Determine state for switches
                            let statePayload = null;
                            if (res.values.state !== undefined) statePayload = res.values.state;
                            else if (res.values.command === 'on' || res.values.switch === 'on') statePayload = true;
                            else if (res.values.command === 'off' || res.values.switch === 'off') statePayload = false;

                            // Publish State
                            Object.keys(res.values).forEach(key => {
                                mqttClient.publish(`${topicBase}/${key}`, res.values[key].toString(), { retain: true });
                            });
                            if (statePayload !== null) {
                                mqttClient.publish(`${topicBase}/state`, statePayload.toString(), { retain: true });
                            }

                            return { ...res, uid, topicBase, groupTimestamp, identityName: identity.name };
                        });

                        io.emit('signal_group', enrichedResults);
                    }
                }
            } catch (e) {
                console.error('Decode Error:', e.message);
            }
        }
    });

    serial.on('error', (err) => io.emit('status', { error: err.message }));
}

server.listen(8080, '0.0.0.0', () => {
    console.log('Bridge Server listening on port 8080 (v3.9.5)');
});
