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

// --- Configuration ---
let options = { 
    serial_port: "/dev/ttyUSB0", 
    baud_rate: 115200, 
    mqtt_broker: "core-mosquitto", 
    mqtt_port: 1883, 
    mqtt_user: "", 
    mqtt_password: "", 
    debug: true 
};

if (fs.existsSync('/data/options.json')) {
    try { 
        options = { ...options, ...JSON.parse(fs.readFileSync('/data/options.json', 'utf8')) }; 
    } catch (e) { 
        console.error('Config Error:', e); 
    }
}

// --- Protocol Patching (Humidity for weather2) ---
const weather2 = rfcontrol.getAllProtocols().find(p => p.name === 'weather2');
if (weather2) {
    weather2.values.humidity = { type: "number" };
    weather2.values.id = { type: "number" };
    const originalDecode = weather2.decodePulses;
    weather2.decodePulses = function(pulses) {
        const result = originalDecode.call(this, pulses);
        const helper = require('rfcontroljs/lib/helper');
        const binary = helper.map(pulses, { '01': '0', '02': '1', '03': '' });
        
        // Extract Humidity (Bits 28-35)
        result.humidity = helper.binaryToNumber(binary, 28, 35);
        // Extract ID (Bits 0-7)
        result.id = helper.binaryToNumber(binary, 0, 7);
        
        return result;
    };
}

// --- Express & Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    path: '/socket.io', 
    cors: { origin: "*" }, 
    transports: ["polling", "websocket"] 
});

app.use(express.static(path.join(__dirname, 'public')));

// --- MQTT Client ---
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { 
    username: options.mqtt_user, 
    password: options.mqtt_password 
});

mqttClient.on('connect', () => console.log('MQTT Connected'));
mqttClient.on('error', (err) => console.error('MQTT Error:', err));

// --- Serial Connection ---
let serial, parser;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
    parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    console.log(`Serial connected to ${options.serial_port} at ${options.baud_rate}`);
} catch (err) { 
    console.error('Serial Error:', err); 
}

if (serial) {
    serial.on('open', () => { 
        // Request signals periodically to keep homeduino alive/receiving
        setInterval(() => serial.write('RF receive 0\n'), 5000); 
    });
    
    parser.on('data', (line) => {
        line = line.trim();
        if (line.includes('RF receive ') || line.match(/^[012\s]+$/)) {
            processSignal(line);
        }
    });
}

// --- Signal Processing ---
function processSignal(line) {
    try {
        if (!line.startsWith('RF receive ')) return;
        const strSeq = line.split(' ').slice(2).join(' ');
        if (options.debug) console.log(`[DEBUG RAW] Received: ${strSeq}`);

        const info = rfcontrol.prepareCompressedPulses(strSeq);
        if (info) {
            const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
            if (results && results.length > 0) {
                const enriched = results.map(res => {
                    // 1. RAW data attachment
                    res.values.raw = strSeq.split(' ').pop();

                    // 2. Improved UID Logic (Hash-based for collisions)
                    const idSource = res.values.id || res.values.systemcode || res.values.unitcode || 'fixed';
                    const hash = crypto.createHash('md5').update(res.protocol + idSource + (res.values.raw || '')).digest('hex').substring(0, 6);
                    res.uid = `hd_${res.protocol}_${res.values.id || hash}`;

                    // 3. Publish to MQTT (State)
                    Object.keys(res.values).forEach(k => {
                        if (k !== 'raw') {
                            mqttClient.publish(`homeduino/${res.protocol}/${res.uid}/${k}`, res.values[k].toString(), { retain: true });
                        }
                    });

                    return { ...res, groupTimestamp: new Date().toISOString() };
                });

                if (options.debug) console.log(`[DEBUG RAW] Enriched: ${JSON.stringify(enriched)}`);
                io.emit('signal_group', enriched);
            }
        }
    } catch (e) { 
        console.error('Processing Error:', e); 
    }
}

// --- Discovery Handler ---
io.on('connection', (socket) => {
    socket.on('add_to_ha', (data) => {
        const { res } = data;
        if (!res || !res.uid) return;

        console.log(`Starting discovery for ${res.uid} (${res.protocol})`);
        
        const device = {
            identifiers: [res.uid],
            name: `Homeduino ${res.protocol} ${res.values.id || ''}`,
            model: res.protocol,
            manufacturer: 'Homeduino Bridge'
        };

        // Temperature
        if (res.values.temperature !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${res.uid}/temperature/config`, JSON.stringify({
                name: "Temperature",
                unique_id: `${res.uid}_temperature`,
                state_topic: `homeduino/${res.protocol}/${res.uid}/temperature`,
                unit_of_measurement: "°C",
                device_class: "temperature",
                device: device
            }), { retain: true });
        }

        // Humidity
        if (res.values.humidity !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${res.uid}/humidity/config`, JSON.stringify({
                name: "Humidity",
                unique_id: `${res.uid}_humidity`,
                state_topic: `homeduino/${res.protocol}/${res.uid}/humidity`,
                unit_of_measurement: "%",
                device_class: "humidity",
                device: device
            }), { retain: true });
        }

        // Switch/Socket
        if (res.values.state !== undefined) {
            mqttClient.publish(`homeassistant/switch/${res.uid}/state/config`, JSON.stringify({
                name: "Switch",
                unique_id: `${res.uid}_switch`,
                state_topic: `homeduino/${res.protocol}/${res.uid}/state`,
                command_topic: `homeduino/${res.protocol}/${res.uid}/set`,
                payload_on: "true",
                payload_off: "false",
                device: device
            }), { retain: true });

            // Subscribe to command topic
            mqttClient.subscribe(`homeduino/${res.protocol}/${res.uid}/set`);
        }
    });
});

// MQTT Command Listener for Switches
mqttClient.on('message', (topic, message) => {
    if (topic.includes('/set')) {
        const parts = topic.split('/');
        const protocol = parts[1];
        const uid = parts[2];
        const state = message.toString() === 'true';

        console.log(`MQTT Command: ${protocol} ${uid} -> ${state}`);
        // Here we would need to encode the message and send it to serial
        // For now, let's just log it. sending requires more protocol-specific logic.
    }
});

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v5.0.2 (Humidity & Discovery Fixed)'));
