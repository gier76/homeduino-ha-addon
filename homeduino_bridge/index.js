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

// --- MQTT Client ---
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { 
    username: options.mqtt_user, 
    password: options.mqtt_password 
});

mqttClient.on('connect', () => {
    console.log('MQTT Connected');
    // Global subscribe to commands
    mqttClient.subscribe('homeduino/+/+/set');
});

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
        // Initial re-trigger
        serial.write('RF receive 0\n');
        // Keep-alive re-trigger every 30s
        setInterval(() => serial.write('RF receive 0\n'), 30000); 
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
        const parts = line.split(' ');
        const strSeq = parts.slice(2).join(' ');
        
        if (options.debug) console.log(`[DEBUG RAW] Received: ${strSeq}`);

        const info = rfcontrol.prepareCompressedPulses(strSeq);
        if (info) {
            const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
            if (results && results.length > 0) {
                const enriched = results.map(res => {
                    // Create stable UID
                    const idSource = res.values.id !== undefined ? res.values.id : 
                                   (res.values.systemcode || res.values.unitcode || '0');
                    
                    // If no ID-like field, use a hash of the raw sequence to avoid collisions
                    const hashSource = res.protocol + JSON.stringify(res.values) + strSeq;
                    const hash = crypto.createHash('md5').update(hashSource).digest('hex').substring(0, 6);
                    
                    res.uid = `hd_${res.protocol}_${idSource !== '0' ? idSource : hash}`;

                    // Update MQTT State
                    Object.keys(res.values).forEach(k => {
                        mqttClient.publish(`homeduino/${res.protocol}/${res.uid}/${k}`, res.values[k].toString(), { retain: true });
                    });

                    // Ensure we are listening for commands for this device if it's a switch
                    if (res.values.state !== undefined || res.values.contact !== undefined) {
                        mqttClient.subscribe(`homeduino/${res.protocol}/${res.uid}/set`);
                    }

                    const output = {
                        ...res,
                        groupTimestamp: new Date().toISOString(),
                        values_json: JSON.stringify(res.values),
                        raw_data: strSeq
                    };
                    
                    console.log(`[DECODED] ${res.protocol} (${res.uid}): ${output.values_json}`);
                    return output;
                });

                io.emit('signal_group', enriched);
            }
        }
    } catch (e) { console.error('Processing Error:', e); }
}

// --- Discovery Handler ---
io.on('connection', (socket) => {
    socket.on('add_to_ha', (data) => {
        const { res } = data;
        if (!res || !res.uid) return;
        
        const values = typeof res.values === 'string' ? JSON.parse(res.values) : res.values;
        const device = {
            identifiers: [res.uid],
            name: `Homeduino ${res.protocol} ${values.id !== undefined ? values.id : ''}`,
            model: res.protocol,
            manufacturer: 'Homeduino Bridge'
        };

        // Temperature
        if (values.temperature !== undefined) {
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
        if (values.humidity !== undefined) {
            mqttClient.publish(`homeassistant/sensor/${res.uid}/humidity/config`, JSON.stringify({
                name: "Humidity",
                unique_id: `${res.uid}_humidity`,
                state_topic: `homeduino/${res.protocol}/${res.uid}/humidity`,
                unit_of_measurement: "%",
                device_class: "humidity",
                device: device
            }), { retain: true });
        }

        // Switch / State
        if (values.state !== undefined) {
            mqttClient.publish(`homeassistant/switch/${res.uid}/state/config`, JSON.stringify({
                name: "Switch",
                unique_id: `${res.uid}_switch`,
                state_topic: `homeduino/${res.protocol}/${res.uid}/state`,
                command_topic: `homeduino/${res.protocol}/${res.uid}/set`,
                payload_on: "true",
                payload_off: "false",
                device: device
            }), { retain: true });
        }
    });
});

// --- MQTT Command Listener (RF SEND) ---
mqttClient.on('message', (topic, message) => {
    const match = topic.match(/homeduino\/(.+)\/(.+)\/set/);
    if (match) {
        const protocolName = match[1];
        const uid = match[2];
        const stateStr = message.toString();
        const state = (stateStr === 'true' || stateStr === 'on' || stateStr === '1');

        console.log(`[SEND] Received MQTT Command for ${uid}: ${state}`);

        try {
            const protocol = rfcontrol.getProtocol(protocolName);
            if (!protocol) throw new Error(`Protocol ${protocolName} not found`);

            // Extract ID from UID (hd_protocol_ID)
            const parts = uid.split('_');
            const id = parts[parts.length - 1];

            // Build message object based on protocol requirements
            const rfMessage = {
                state: state
            };
            
            // Assign ID (handle numeric or systemcode/unitcode)
            if (protocol.values.id) rfMessage.id = parseInt(id) || 0;
            if (protocol.values.systemcode) rfMessage.systemcode = id; // simplified
            if (protocol.values.unitcode) rfMessage.unitcode = 0;

            const encoded = rfcontrol.encodeMessage(protocolName, rfMessage);
            if (encoded) {
                // Format: "RF send <p1> <p2> <p3> <p4> <p5> <p6> <p7> <p8> <pulseCount> <pulses>"
                let sendCmd = "RF send ";
                for(let i=0; i<8; i++) {
                    sendCmd += (encoded.pulseLengths[i] || 0) + " ";
                }
                sendCmd += encoded.pulses.length + " " + encoded.pulses + "\n";
                
                if (serial) {
                    console.log(`[SERIAL SEND] ${sendCmd.trim()}`);
                    serial.write(sendCmd);
                    // Optimistic update
                    mqttClient.publish(`homeduino/${protocolName}/${uid}/state`, state.toString(), { retain: true });
                }
            } else {
                console.error(`[SEND ERROR] Could not encode message for ${protocolName}`);
            }
        } catch (e) {
            console.error(`[SEND ERROR] ${e.message}`);
        }
    }
});

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v5.0.3 (Ready for Switches)'));
