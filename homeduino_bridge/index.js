const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
// Vendored full rfcontroljs stack (pimatic/rfcontroljs v0.0.61) — the npm package
// rfcontroljs@0.0.10 only ships 9 protocols and lacks pulseCounts support.
const rfcontrol = require('./vendor/controller');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const VERSION = "5.1.9";

// --- Configuration ---
let options = {
    serial_port: "/dev/ttyUSB0",
    baud_rate: 115200,
    mqtt_broker: "core-mosquitto",
    mqtt_port: 1883,
    mqtt_user: "",
    mqtt_password: "",
    debug: true,
    rf_transmitter_pin: 4,
    rf_repeats: 5
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
        const helper = require('./vendor/helper');
        const binary = helper.map(pulses, { '01': '0', '02': '1', '03': '' });
        result.humidity = helper.binaryToNumber(binary, 28, 35);
        result.id = helper.binaryToNumber(binary, 0, 7);
        return result;
    };
}

// The vendored controller loads all 87 upstream protocols itself; no extra registration needed.

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
    // Subscribe to ALL homeduino command topics
    mqttClient.subscribe('homeduino/+/+/set');

    // AUTO-DISCOVERY for specific known devices
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
const lastDimlevel = {}; // uid -> last seen dimlevel (1..15), for dimmer sends without brightness

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

                    if (v.dimlevel !== undefined) lastDimlevel[res.uid] = v.dimlevel;

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

        // Weather sensors (temperature/humidity + extra weather fields, mirroring the HA reference integration)
        if (values.temperature !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${device_id}/temperature/config`, JSON.stringify({
                name: "Temperature", unique_id: `${device_id}_temperature`,
                state_topic: `homeduino/${res.protocol}/${device_id}/temperature`,
                unit_of_measurement: "°C", device_class: "temperature", device: device
            }), { retain: true });
        }

        if (values.humidity !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${device_id}/humidity/config`, JSON.stringify({
                name: "Humidity", unique_id: `${device_id}_humidity`,
                state_topic: `homeduino/${res.protocol}/${device_id}/humidity`,
                unit_of_measurement: "%", device_class: "humidity", device: device
            }), { retain: true });
        }

        const extraSensors = {
            avgAirspeed: { label: "Wind Speed (avg)", unit: "m/s", class: "wind_speed" },
            windGust: { label: "Wind Gust", unit: "m/s", class: "wind_speed" },
            windDirection: { label: "Wind Direction", unit: "°", class: "wind_direction" },
            rain: { label: "Rain", unit: "mm", class: "precipitation" },
            barometricPressure: { label: "Barometric Pressure", unit: "hPa", class: "pressure" },
            brightness: { label: "Brightness", unit: "lx", class: "illuminance" },
            co2: { label: "CO2", unit: "ppm" }
        };
        Object.keys(extraSensors).forEach(field => {
            if (values[field] !== undefined) {
                const s = extraSensors[field];
                mqttClient.publish(`homeassistant/sensor/${device_id}/${field}/config`, JSON.stringify({
                    name: s.label, unique_id: `${device_id}_${field}`,
                    state_topic: `homeduino/${res.protocol}/${device_id}/${field}`,
                    unit_of_measurement: s.unit, ...(s.class ? { device_class: s.class } : {}), device: device
                }), { retain: true });
            }
        });

        // Battery sensor for protocols reporting lowBattery
        if (values.lowBattery !== undefined) {
            mqttClient.publish(`homeassistant/binary_sensor/${device_id}/battery/config`, JSON.stringify({
                name: "Battery", unique_id: `${device_id}_battery`,
                state_topic: `homeduino/${res.protocol}/${device_id}/lowBattery`,
                device_class: "battery", payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
        }

        // Dimmer -> light (brightness = dimlevel * 17, like the HA reference integration)
        if (res.protocol.startsWith('dimmer') && values.state !== undefined) {
            mqttClient.publish(`homeassistant/light/${device_id}/config`, JSON.stringify({
                name: "Light", unique_id: `${device_id}_light`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                command_topic: `homeduino/${res.protocol}/${device_id}/set`,
                brightness_topic: `homeduino/${res.protocol}/${device_id}/dimlevel`,
                brightness_template: "{{ value * 17 }}",
                payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
        }

        // PIR -> motion sensor, contact -> door sensor (contact state is inverted, like reference)
        if (res.protocol.startsWith('pir') && values.state !== undefined) {
            mqttClient.publish(`homeassistant/binary_sensor/${device_id}/motion/config`, JSON.stringify({
                name: "Motion", unique_id: `${device_id}_motion`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                device_class: "motion", payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
        }
        if (res.protocol.startsWith('contact') && values.state !== undefined) {
            mqttClient.publish(`homeassistant/binary_sensor/${device_id}/contact/config`, JSON.stringify({
                name: "Contact", unique_id: `${device_id}_contact`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                device_class: "door", payload_on: "false", payload_off: "true", device: device
            }), { retain: true });
        }
        if (res.protocol.startsWith('alarm') && values.state !== undefined) {
            mqttClient.publish(`homeassistant/binary_sensor/${device_id}/alarm/config`, JSON.stringify({
                name: "Alarm", unique_id: `${device_id}_alarm`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                device_class: "alarm", payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
        }
        if (res.protocol.startsWith('doorbell') && values.state !== undefined) {
            mqttClient.publish(`homeassistant/binary_sensor/${device_id}/doorbell/config`, JSON.stringify({
                name: "Doorbell", unique_id: `${device_id}_doorbell`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                device_class: "door", payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
        }

        // Switch (plain state protocols: switch*, led*, shutter*, awning*, rolling1, ...)
        if (values.state !== undefined && !res.protocol.startsWith('dimmer')
            && !res.protocol.startsWith('pir') && !res.protocol.startsWith('contact')
            && !res.protocol.startsWith('alarm') && !res.protocol.startsWith('doorbell')) {
            mqttClient.publish(`homeassistant/switch/${device_id}/config`, JSON.stringify({
                name: "Switch", unique_id: `${device_id}_switch`,
                state_topic: `homeduino/${res.protocol}/${device_id}/state`,
                command_topic: `homeduino/${res.protocol}/${device_id}/set`,
                payload_on: "true", payload_off: "false", device: device
            }), { retain: true });
        }
    });
});

// Helper for type conversion when building RF message values
function parseValueForProtocol(valStr, schemaDef) {
    if (!valStr) return valStr;
    if (schemaDef && schemaDef.type === 'number') {
        const parsed = parseInt(valStr, 10);
        return isNaN(parsed) ? valStr : parsed;
    }
    if (schemaDef && schemaDef.type === 'boolean') {
        return valStr === 'true' || valStr === '1';
    }
    return valStr;
}

// --- MQTT Command Listener ---
mqttClient.on('message', (topic, message) => {
    const match = topic.match(/homeduino\/(.+)\/(.+)\/set/);
    if (match) {
        const protocolName = match[1];
        const uid = match[2];
        const rawPayload = message.toString().trim();
        let stateStr = rawPayload.toLowerCase();
        let brightness = null;
        // Home Assistant MQTT lights send JSON like {"state":"ON","brightness":191}
        if (rawPayload.startsWith('{')) {
            try {
                const j = JSON.parse(rawPayload);
                stateStr = String(j.state === true || j.state === 'ON' || j.state === 'on' || j.state === 'true' ? 'true' : 'false');
                if (j.brightness !== undefined && j.brightness !== null) brightness = j.brightness;
            } catch (e) {
                stateStr = rawPayload.toLowerCase();
            }
        }
        const state = (stateStr === 'true' || stateStr === 'on' || stateStr === '1');

        console.log(`[SEND] MQTT Command received for ${protocolName} (${uid}): ${rawPayload} -> state=${state}`);

        try {
            const protocol = rfcontrol.getProtocol(protocolName);
            if (!protocol) {
                console.error(`[SEND ERROR] Unknown protocol: ${protocolName}`);
                return;
            }
            const uidParts = uid.split('_').slice(2);

            const rfMsg = { state: state };
            let idx = 0;
            const valuesSchema = protocol.values || {};

            if (valuesSchema.id) rfMsg.id = parseValueForProtocol(uidParts[idx++], valuesSchema.id);
            if (valuesSchema.houseCode) rfMsg.houseCode = parseValueForProtocol(uidParts[idx++], valuesSchema.houseCode);
            if (valuesSchema.unitCode) rfMsg.unitCode = parseValueForProtocol(uidParts[idx++], valuesSchema.unitCode);
            if (valuesSchema.systemcode) rfMsg.systemcode = parseValueForProtocol(uidParts[idx++], valuesSchema.systemcode);
            if (valuesSchema.unitcode) rfMsg.unitcode = parseValueForProtocol(uidParts[idx++], valuesSchema.unitcode);
            if (valuesSchema.unit) rfMsg.unit = parseValueForProtocol(uidParts[idx++], valuesSchema.unit);
            if (valuesSchema.channel) rfMsg.channel = parseValueForProtocol(uidParts[idx++], valuesSchema.channel);
            if (valuesSchema.all) rfMsg.all = (uidParts[idx++] === 'all');
            if (valuesSchema.dimlevel) {
                // dimlevel 1..15; HA light brightness 0..255 maps via /17 (reference integration)
                let dim = 15;
                if (brightness !== null) dim = Math.min(15, Math.max(1, Math.floor(brightness / 17)));
                else if (lastDimlevel[uid] !== undefined) dim = lastDimlevel[uid];
                if (!state) dim = 0;
                rfMsg.dimlevel = dim;
            }

            console.log(`[SEND] Encoding msg for ${protocolName}:`, JSON.stringify(rfMsg));

            const encoded = rfcontrol.encodeMessage(protocolName, rfMsg);
            if (encoded) {
                const pl = encoded.pulseLengths;
                let fullPl = Array(8).fill(0);
                for(let i=0; i<pl.length && i<8; i++) fullPl[i] = pl[i];

                // Build correct RF send command using configured pin and repeats
                const transmitterPin = options.rf_transmitter_pin !== undefined ? options.rf_transmitter_pin : 4;
                const repeats = options.rf_repeats !== undefined ? options.rf_repeats : 5;
                let sendCmd = `RF send ${transmitterPin} ${repeats} `;
                fullPl.forEach(p => sendCmd += p + " ");
                // Append the compressed pulse string
                sendCmd += `${encoded.pulses}\n`;

                if (serial && serial.isOpen) {
                    console.log(`[SERIAL SEND] ${sendCmd.trim()}`);
                    serial.write(sendCmd);

                    const stateFeedback = state ? 'true' : 'false';
                    mqttClient.publish(`homeduino/${protocolName}/${uid}/state`, stateFeedback, { retain: true });
                    if (rfMsg.dimlevel !== undefined) {
                        mqttClient.publish(`homeduino/${protocolName}/${uid}/dimlevel`, String(state ? rfMsg.dimlevel : 0), { retain: true });
                    }
                    // Re-enable receiving after 200ms to resume listening
                    setTimeout(() => {
                        if (serial && serial.isOpen) serial.write('RF receive 0\n');
                    }, 200);
                } else {
                    console.error('[SERIAL ERROR] Cannot send command: Serial port is not open');
                }
            } else {
                console.error(`[SEND ERROR] rfcontrol.encodeMessage failed for ${protocolName}`);
            }
        } catch (e) { console.error('[SEND ERROR]', e.message, e.stack); }
    }
});

server.listen(8080, '0.0.0.0', () => console.log(`Bridge Server v${VERSION} (MQTT Switch & Status Fixes)`));
