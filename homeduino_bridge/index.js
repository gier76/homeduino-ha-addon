const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// --- Configuration Handling (v3.8.9) ---
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

// --- Manual Discovery Logic ---
function sendDiscovery(protocol, uid, values, friendlyName) {
    const topicBase = `homeduino/${protocol}/${uid}`;
    const device = {
        identifiers: [uid],
        name: friendlyName || `${protocol} ${uid}`,
        model: protocol,
        manufacturer: "Homeduino",
        sw_version: "3.8.9"
    };

    console.log(`Sending Manual Discovery for ${uid} as "${friendlyName}"`);

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

    // Humidity Sensor
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
    
    // Battery Sensor
    if (values.battery !== undefined) {
         mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_bat/config`, JSON.stringify({
            name: `${device.name} Battery`,
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
        const { protocol, values, name, uid } = data;
        sendDiscovery(protocol, uid, values, name);
    });

    socket.on('send_command', (data) => {
        const { protocol, values } = data;
        try {
            const result = rfcontrol.encodeMessage(protocol, values);
            if (result && serial && serial.isOpen) {
                const cmd = `RF send 4 ${result.pulseLengths.length} ${result.pulseLengths.join(' ')} ${result.pulses}`;
                serial.write(cmd + '\n');
                console.log('Sent command:', cmd);
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
        if (options.debug) console.log('Raw:', line);
        
        if (line.startsWith('RF receive ')) {
            try {
                const parts = line.split(' ');
                const strSeq = parts.slice(2).join(' ');
                const info = rfcontrol.prepareCompressedPulses(strSeq);
                if (info) {
                    const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                    if (results && results.length > 0) {
                        const enrichedResults = results.map(res => {
                            // Improved UID generation: Use id and/or channel. Fallback to hash of pulses.
                            let idSuffix = res.values.id !== undefined ? res.values.id : '';
                            if (res.values.channel !== undefined) idSuffix += (idSuffix ? '_' : '') + 'ch' + res.values.channel;
                            if (!idSuffix) {
                                // Extract meaningful bits from the pulse sequence for the hash
                                const pulseData = strSeq.split(' ').slice(-1)[0];
                                idSuffix = 'hash_' + pulseData.substring(pulseData.length - 10); 
                            }
                            
                            const uid = `hd_${res.protocol}_${idSuffix}`;
                            const topicBase = `homeduino/${res.protocol}/${uid}`;

                            // Publish State
                            Object.keys(res.values).forEach(key => {
                                mqttClient.publish(`${topicBase}/${key}`, res.values[key].toString(), { retain: true });
                            });

                            return { ...res, uid, topicBase };
                        });

                        // Stream to UI
                        io.emit('signal', enrichedResults);
                        console.log('Emitted enriched signals:', JSON.stringify(enrichedResults));
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
    console.log('Bridge Server listening on port 8080 (v3.8.9)');
});
