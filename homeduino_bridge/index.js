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

// --- Configuration Handling (v3.9.3) ---
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
    parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
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

mqttClient.on('connect', () => {
    console.log('MQTT Connected');
    mqttClient.subscribe('homeduino/command/#');
    io.emit('mqtt_status', { connected: true, broker: options.mqtt_broker });
});

mqttClient.on('error', (err) => {
    console.error('MQTT Error:', err.message);
    io.emit('mqtt_status', { connected: false, error: err.message });
});

mqttClient.on('message', (topic, message) => {
    // Handle incoming MQTT commands for switches
    // Topic: homeduino/command/protocol/uid
    if (topic.startsWith('homeduino/command/')) {
        const parts = topic.split('/');
        if (parts.length >= 4) {
            const protocol = parts[2];
            // We assume the payload contains the values needed to switch
            // But usually HA sends "ON" or "OFF" as payload
            // We need to reconstruct the full values object from what we stored or infer it
            console.log(`MQTT Command received: ${topic} -> ${message.toString()}`);
            // TODO: Implement robust MQTT command handling back to RF
        }
    }
});

// --- Helper for Robust Hash ---
function generateSecureHash(str) {
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 10);
}

// --- Helper to construct a better name/ID ---
function constructDeviceIdentity(protocol, values, rawHash) {
    let parts = [];
    
    // ID / Address
    if (values.id !== undefined) parts.push(`id-${values.id}`);
    if (values.address !== undefined) parts.push(`addr-${values.address}`);
    
    // System / Unit / Channel
    if (values.systemcode !== undefined) parts.push(`sys-${values.systemcode}`);
    if (values.unitcode !== undefined) parts.push(`unit-${values.unitcode}`);
    if (values.unit !== undefined) parts.push(`unit-${values.unit}`);
    if (values.channel !== undefined) parts.push(`ch-${values.channel}`);
    if (values.house !== undefined) parts.push(`house-${values.house}`);
    if (values.group !== undefined) parts.push(`grp-${values.group}`);

    let idSuffix = parts.join('_');
    
    // Fallback if no identifiers found
    if (!idSuffix) {
        idSuffix = 'raw_' + rawHash;
    }

    const uid = `hd_${protocol}_${idSuffix}`.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const name = `${protocol} ${parts.join(' ')}`.trim() || `${protocol} Unknown`;

    return { uid, name, idSuffix };
}

// --- Manual Discovery Logic ---
function sendDiscovery(protocol, uid, values, friendlyName) {
    if (!uid) return;
    const topicBase = `homeduino/${protocol}/${uid}`;
    const device = {
        identifiers: [uid],
        name: friendlyName,
        model: protocol,
        manufacturer: "Homeduino",
        sw_version: "3.9.3"
    };

    console.log(`[DISCOVERY] Registering ${uid} as "${device.name}"`);

    // Temperature Sensor
    if (values.temperature !== undefined) {
        mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_temp/config`, JSON.stringify({
            name: `${device.name} Temperature`,
            unique_id: `${uid}_temp`,
            state_topic: `${topicBase}/temperature`,
            device_class: "temperature",
            unit_of_measurement: "°C",
            value_template: "{{ value }}",
            device: device
        }), { retain: true });
    }

    // Humidity Sensor (Even if currently undefined, we register it if protocol supports it usually)
    // For now only if present to avoid empty entities
    if (values.humidity !== undefined) {
        mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_hum/config`, JSON.stringify({
            name: `${device.name} Humidity`,
            unique_id: `${uid}_hum`,
            state_topic: `${topicBase}/humidity`,
            device_class: "humidity",
            unit_of_measurement: "%",
            value_template: "{{ value }}",
            device: device
        }), { retain: true });
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
    console.log('UI Client connected');
    socket.emit('mqtt_status', { connected: mqttClient.connected, broker: options.mqtt_broker });
    
    if (serial && serial.isOpen) {
        socket.emit('status', { connected: true });
    }

    socket.on('add_device', (data) => {
        let { protocol, values, name, uid } = data;
        
        // If name is not provided or generic, try to improve it
        if (!name) {
             const identity = constructDeviceIdentity(protocol, values, 'manual');
             name = identity.name;
             uid = identity.uid;
        }
        
        sendDiscovery(protocol, uid, values, name);
    });

    socket.on('send_command', (data) => {
        const { protocol, values } = data;
        console.log(`[CMD] Sending to ${protocol}:`, JSON.stringify(values));
        
        try {
            // Ensure we encode exactly what was received/requested
            const result = rfcontrol.encodeMessage(protocol, values);
            if (result && serial && serial.isOpen) {
                const cmd = `RF send 4 ${result.pulseLengths.length} ${result.pulseLengths.join(' ')} ${result.pulses}`;
                serial.write(cmd + '\n');
                console.log('Sent raw command:', cmd);
            } else {
                console.error("Failed to encode message or serial not open");
            }
        } catch (e) {
            console.error('Encode Error:', e.message);
        }
    });
});

// --- Logic ---
if (serial) {
    serial.on('open', () => {
        console.log(`Serial connected on ${options.serial_port}`);
        io.emit('status', { connected: true });
        setTimeout(() => serial.write('\nRF receive 0\n'), 2000);
    });

    parser.on('data', (line) => {
        line = line.trim();
        if (options.debug && line.startsWith('RF receive')) console.log('Raw:', line);
        
        if (line.startsWith('RF receive ')) {
            try {
                const parts = line.split(' ');
                const strSeq = parts.slice(2).join(' ');
                const info = rfcontrol.prepareCompressedPulses(strSeq);
                
                if (info) {
                    const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                    
                    if (results && results.length > 0) {
                        // Generate a raw hash for fallback identification
                        // Use the pulse string (last part of line) for consistency
                        const pulseStr = parts.slice(-1)[0]; 
                        const rawHash = generateSecureHash(pulseStr);

                        const enrichedResults = results.map(res => {
                            const identity = constructDeviceIdentity(res.protocol, res.values, rawHash);
                            const uid = identity.uid;
                            const topicBase = `homeduino/${res.protocol}/${uid}`;

                            // Determine state for switches
                            let statePayload = null;
                            if (res.values.state !== undefined) statePayload = res.values.state;
                            if (res.values.command === 'on' || res.values.switch === 'on') statePayload = true;
                            if (res.values.command === 'off' || res.values.switch === 'off') statePayload = false;

                            // Publish State
                            Object.keys(res.values).forEach(key => {
                                const val = res.values[key];
                                mqttClient.publish(`${topicBase}/${key}`, val.toString(), { retain: true });
                            });
                            
                            // Publish unified state for switches
                            if (statePayload !== null) {
                                mqttClient.publish(`${topicBase}/state`, statePayload.toString(), { retain: true });
                            }

                            return { ...res, uid, topicBase, identityName: identity.name };
                        });

                        io.emit('signal', enrichedResults);
                    }
                }
            } catch (e) {
                console.error('Decode Error:', e.message);
            }
        }
    });

    serial.on('error', (err) => {
        console.error('Serial Error:', err.message);
        io.emit('status', { error: err.message });
    });
}

server.listen(8080, '0.0.0.0', () => {
    console.log('Bridge Server listening on port 8080 (v3.9.3)');
});
