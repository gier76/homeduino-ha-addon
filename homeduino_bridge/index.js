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

const VERSION = "5.1.5";

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
        const fileConfig = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        options = { ...options, ...fileConfig }; 
        console.log('Config loaded from /data/options.json');
    } catch (e) { 
        console.error('Config Error:', e); 
    }
}

// --- Protocol Patching (Humidity & ID for weather2) ---
const weather2 = rfcontrol.getAllProtocols().find(p => p.name === 'weather2');
if (weather2) {
    weather2.values.humidity = { type: "number" };
    weather2.values.id = { type: "number" };
    const originalDecode = weather2.decodePulses;
    weather2.decodePulses = function(pulses) {
        const result = originalDecode.call(this, pulses);
        const helper = require('rfcontroljs/lib/helper');
        const binary = helper.map(pulses, { '01': '0', '02': '1', '03': '' });
        result.humidity = helper.binaryToNumber(binary, 28, 35);
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

// --- Connection States ---
let mqttConnected = false;
let serialConnected = false;

function getStatusPayload() {
    return {
        version: VERSION,
        mqttConnected: mqttConnected,
        mqttBroker: `${options.mqtt_broker}:${options.mqtt_port}`,
        serialConnected: serialConnected,
        serialPort: options.serial_port
    };
}

function broadcastStatus() {
    io.emit('status_update', getStatusPayload());
}

// --- MQTT Client ---
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { 
    username: options.mqtt_user, 
    password: options.mqtt_password 
});

mqttClient.on('connect', () => {
    mqttConnected = true;
    broadcastStatus();
    console.log('MQTT Connected');
    mqttClient.subscribe('homeduino/+/+/set');

    // AUTO-DISCOVERY for specific known devices (v5.1.5)
    setTimeout(() => {
        const knownDevices = [
            { protocol: 'switch2', uid: 'hd_switch2_31_4', name: 'Homeduino Switch 31 4', values: { state: false } }
        ];
        
        knownDevices.forEach(d => {
            const device = {
                identifiers: [d.uid],
                name: d.name,
                model: d.protocol,
                manufacturer: 'Homeduino Bridge',
                sw_version: VERSION
            };
            const configTopic = `homeassistant/switch/${d.uid}/config`;
            const configPayload = {
                name: `${d.name}`,
                unique_id: `${d.uid}_switch`,
                state_topic: `homeduino/${d.protocol}/${d.uid}/state`,
                command_topic: `homeduino/${d.protocol}/${d.uid}/set`,
                payload_on: "true", payload_off: "false",
                device: device
            };
            console.log(`[AUTO-DISCOVERY] Sending config to ${configTopic}`);
            mqttClient.publish(configTopic, JSON.stringify(configPayload), { retain: true });
            mqttClient.subscribe(`homeduino/${d.protocol}/${d.uid}/set`);
        });
    }, 2000);
});

mqttClient.on('offline', () => {
    mqttConnected = false;
    broadcastStatus();
});

mqttClient.on('close', () => {
    mqttConnected = false;
    broadcastStatus();
});

mqttClient.on('error', (err) => {
    mqttConnected = false;
    broadcastStatus();
    console.error('MQTT Error:', err.message);
});

// --- Serial Connection ---
let serial, parser;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
    parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    console.log(`Serial connected to ${options.serial_port} at ${options.baud_rate}`);
} catch (err) { 
    console.error('Serial Error:', err.message); 
}

if (serial) {
    serial.on('open', () => { 
        serialConnected = true;
        broadcastStatus();
        console.log('Serial port opened, starting receiver...');
        serial.write('RF receive 0\n');
        setInterval(() => {
            if (serial && serial.isOpen) {
                serial.write('RF receive 0\n');
            }
        }, 5000); 
    });

    serial.on('close', () => {
        serialConnected = false;
        broadcastStatus();
        console.log('Serial port closed');
    });

    serial.on('error', (err) => {
        serialConnected = false;
        broadcastStatus();
        console.error('Serial Error:', err.message);
    });
    
    parser.on('data', (line) => {
        line = line.trim();
        if (line.includes('RF receive ') || line.match(/^[012\s]+$/)) {
            processSignal(line);
        } else if (line.length > 0) {
            console.log(`[SERIAL] ${line}`);
        }
    });
}

// --- Signal Processing ---
function processSignal(line) {
    try {
        if (!line.startsWith('RF receive ')) return;
        const strSeq = line.split(' ').slice(2).join(' ');
        
        if (options.debug) console.log(`[RAW] ${strSeq}`);

        const info = rfcontrol.prepareCompressedPulses(strSeq);
        if (info) {
            const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
            if (results && results.length > 0) {
                const enriched = results.map(res => {
                    let idParts = [];
                    const v = res.values;
                    
                    if (v.id !== undefined) idParts.push(v.id);
                    if (v.houseCode !== undefined) idParts.push(v.houseCode);
                    if (v.unitCode !== undefined) idParts.push(v.unitCode);
                    if (v.systemcode !== undefined) idParts.push(v.systemcode);
                    if (v.unitcode !== undefined) idParts.push(v.unitcode);
                    if (v.unit !== undefined) idParts.push(v.unit);
                    if (v.channel !== undefined) idParts.push(v.channel);
                    if (v.all !== undefined) idParts.push(v.all ? 'all' : 'single');

                    let idString = idParts.join('_');
                    if (!idString) {
                        idString = crypto.createHash('md5').update(res.protocol + JSON.stringify(v)).digest('hex').substring(0, 6);
                    }
                    
                    res.uid = `hd_${res.protocol}_${idString}`;

                    // Update MQTT State
                    Object.keys(v).forEach(k => {
                        if (k !== 'raw') {
                            let val = v[k];
                            // Standardize state to "true"/"false" for Home Assistant
                            if (k === 'state') {
                                const lowerStr = String(val).toLowerCase();
                                val = (val === 1 || val === true || lowerStr === 'on' || lowerStr === 'true' || lowerStr === '1') ? 'true' : 'false';
                            }
                            mqttClient.publish(`homeduino/${res.protocol}/${res.uid}/${k}`, val.toString(), { retain: true });
                        }
                    });

                    if (v.state !== undefined) {
                        mqttClient.subscribe(`homeduino/${res.protocol}/${res.uid}/set`);
                    }

                    const output = {
                        ...res,
                        sw_version: VERSION,
                        groupTimestamp: new Date().toISOString(),
                        values_json: JSON.stringify(res.values),
                        raw_data: strSeq
                    };
                    
                    console.log(`[DECODED] ${res.protocol} (${res.uid}): ${output.values_json}`);
                    return output;
                });

                if (enriched.length > 1) {
                    console.log(`[DEBUG] Signal matched ${enriched.length} protocols: ${enriched.map(e => e.protocol).join(', ')}`);
                }

                io.emit('signal_group', enriched);
            } else if (options.debug) {
                console.log(`[INFO] Signal received but no protocol matched.`);
            }
        }
    } catch (e) { console.error('Processing Error:', e); }
}

// --- Discovery Handler & Status Initializer ---
io.on('connection', (socket) => {
    // Send status update on connection
    socket.emit('status_update', getStatusPayload());

    socket.on('add_to_ha', (data) => {
        const { res } = data;
        if (!res || !res.uid) return;
        
        const values = typeof res.values === 'string' ? JSON.parse(res.values) : res.values;
        const device_id = res.uid;
        
        const device = {
            identifiers: [device_id],
            name: `Homeduino ${res.protocol} ${device_id.split('_').slice(2).join(' ')}`,
            model: res.protocol,
            manufacturer: 'Homeduino Bridge',
            sw_version: VERSION
        };
        console.log(`[DISCOVERY] Sending config for ${device_id} to MQTT...`);

        // Temperature
        if (values.temperature !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${device_id}/temperature/config`, JSON.stringify({
                name: "Temperature", unique_id: `${device_id}_temperature`,
                state_topic: `homeduino/${res.protocol}/${device_id}/temperature`,
                unit_of_measurement: "°C", device_class: "temperature", device: device
            }), { retain: true });
        }

        // Humidity
        if (values.humidity !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${device_id}/humidity/config`, JSON.stringify({
                name: "Humidity", unique_id: `${device_id}_humidity`,
                state_topic: `homeduino/${res.protocol}/${device_id}/humidity`,
                unit_of_measurement: "%", device_class: "humidity", device: device
            }), { retain: true });
        }

        // Switch
        if (values.state !== undefined) {
            mqttClient.publish(`homeassistant/switch/${device_id}/config`, JSON.stringify({
                name: "Switch", unique_id: `${device_id}_switch`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                command_topic: `homeduino/${res.protocol}/${device_id}/set`,
                payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
            mqttClient.subscribe(`homeduino/${res.protocol}/${device_id}/set`);
        }
    });
});

// --- MQTT Command Listener ---
mqttClient.on('message', (topic, message) => {
    const match = topic.match(/homeduino\/(.+)\/(.+)\/set/);
    if (match) {
        const protocolName = match[1];
        const uid = match[2];
        const stateStr = message.toString().trim().toLowerCase();
        const state = (stateStr === 'true' || stateStr === 'on' || stateStr === '1');

        console.log(`[SEND] MQTT Command for ${protocolName} (${uid}): ${state}`);

        try {
            const protocol = rfcontrol.getProtocol(protocolName);
            if (!protocol) {
                console.error(`[SEND ERROR] Unknown protocol: ${protocolName}`);
                return;
            }
            const uidParts = uid.split('_').slice(2); 

            const rfMsg = { state: state };
            let idx = 0;
            if (protocol.values.id) rfMsg.id = parseInt(uidParts[idx++], 10);
            if (protocol.values.houseCode) rfMsg.houseCode = parseInt(uidParts[idx++], 10);
            if (protocol.values.unitCode) rfMsg.unitCode = parseInt(uidParts[idx++], 10);
            if (protocol.values.systemcode) rfMsg.systemcode = uidParts[idx++];
            if (protocol.values.unitcode) rfMsg.unitcode = parseInt(uidParts[idx++], 10);
            if (protocol.values.unit) rfMsg.unit = parseInt(uidParts[idx++], 10);
            if (protocol.values.channel) rfMsg.channel = parseInt(uidParts[idx++], 10);
            if (protocol.values.all) rfMsg.all = (uidParts[idx++] === 'all');

            const encoded = rfcontrol.encodeMessage(protocolName, rfMsg);
            if (encoded) {
                const pl = encoded.pulseLengths;
                let fullPl = Array(8).fill(0);
                for(let i=0; i<pl.length && i<8; i++) fullPl[i] = pl[i];

                let sendCmd = `RF send ${fullPl.length} `;
                fullPl.forEach(p => sendCmd += p + " ");
                sendCmd += `${encoded.pulses.length} ${encoded.pulses}\n`;
                
                if (serial && serial.isOpen) {
                    console.log(`[SERIAL SEND] ${sendCmd.trim()}`);
                    // Repeat 5 times for 433MHz reliability
                    for (let r = 0; r < 5; r++) {
                        setTimeout(() => {
                            if (serial && serial.isOpen) serial.write(sendCmd);
                        }, r * 40);
                    }
                    
                    const stateFeedback = state ? 'true' : 'false';
                    mqttClient.publish(`homeduino/${protocolName}/${uid}/state`, stateFeedback, { retain: true });
                } else {
                    console.error('[SERIAL ERROR] Cannot send command: Serial port is not open');
                }
            }
        } catch (e) { console.error('[SEND ERROR]', e.message); }
    }
});

server.listen(8080, '0.0.0.0', () => console.log(`Bridge Server v${VERSION} (MQTT Switch & Status Fixes)`));

