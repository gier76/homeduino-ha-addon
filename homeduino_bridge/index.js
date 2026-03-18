const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const EventEmitter = require('events');

// --- Configuration ---
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
        console.log("Loaded options from /data/options.json");
    } catch (e) {
        console.error("Failed to parse /data/options.json", e);
    }
}

function log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
}

function debug(msg) {
    if (options.debug) {
        log(`DEBUG: ${msg}`);
    }
}

// --- Homeduino Hardware ---
class Homeduino extends EventEmitter {
    constructor(port, baudRate) {
        super();
        this.port = port;
        this.baudRate = parseInt(baudRate) || 115200;
        this.serial = null;
        this.parser = null;
        this.connected = false;
    }

    connect() {
        log(`Connecting to serial port: ${this.port} at ${this.baudRate} baud`);
        this.serial = new SerialPort({
            path: this.port,
            baudRate: this.baudRate,
            autoOpen: false,
            lock: false
        });

        this.parser = this.serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));

        this.serial.open((err) => {
            if (err) {
                log(`Serial Error: ${err.message}`);
                this.emit('error', err.message);
                setTimeout(() => this.connect(), 10000);
                return;
            }
            this.connected = true;
            log('Serial Port Opened. Waiting for Arduino...');
            
            // Warte auf Arduino-Boot
            setTimeout(() => {
                log('Sending init signal (RF receive 0)...');
                // Sende leeren Befehl zum Leeren des Buffers
                this.write('');
                this.write('RF receive 0');
                
                // Wiederhole init alle 5s, bis "ready" kommt
                const checkInterval = setInterval(() => {
                    if (this.connected) {
                         this.write('RF receive 0');
                    }
                    else clearInterval(checkInterval);
                }, 5000);
                this.once('ready', () => {
                    log('Arduino acknowledged ready.');
                    clearInterval(checkInterval);
                });
            }, 3000); // Etwas kürzer, da der Serial-Port jetzt erst bereit ist
            
            this.emit('connected');
        });

        this.parser.on('data', (line) => this.handleLine(line));
        
        this.serial.on('error', (err) => {
            log(`Serial Error: ${err.message}`);
            this.connected = false;
            this.emit('error', err.message);
        });

        this.serial.on('close', () => {
            log('Serial Port Closed');
            this.connected = false;
            this.emit('disconnected');
            // Retry after 10 seconds
            setTimeout(() => this.connect(), 10000);
        });
    }

    handleLine(line) {
        line = line.trim();
        if (!line) return;
        debug(`Serial In: ${line}`);

        if (line === 'ready') {
            log('Homeduino ready');
            this.write('RF receive 0');
            return;
        }

        if (line.startsWith('RF receive ')) {
            const parts = line.split(' ');
            // Format: RF receive [state] [pulses...]
            const strSeq = parts.slice(2).join(' ');
            const pulses = strSeq.split(' ').filter(p => p !== '0');
            
            if (pulses.length < 6) return;

            try {
                const info = rfcontrol.prepareCompressedPulses(strSeq);
                if (info && Array.isArray(info.pulseLengths)) {
                    const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
                    if (Array.isArray(results)) {
                        results.forEach(res => {
                            if (res && res.values && res.protocol) {
                                debug(`Decoded: ${res.protocol} ${JSON.stringify(res.values)}`);
                                this.emit('rfControlReceive', {
                                    protocol: res.protocol,
                                    values: res.values,
                                    raw: strSeq,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        });
                    }
                }
            } catch (e) {
                log(`Decoder Error: ${e.message}`);
            }
        }
    }

    write(cmd) {
        if (!this.connected) return;
        debug(`Serial Out: ${cmd}`);
        this.serial.write(cmd + '\n');
    }

    send(protocol, values) {
        try {
            const result = rfcontrol.encodeMessage(protocol, values);
            if (!result) {
                log(`Failed to encode message for protocol ${protocol}`);
                return;
            }
            const cmd = `RF send 4 ${result.pulseLengths.length} ${result.pulseLengths.join(' ')} ${result.pulses}`;
            this.write(cmd);
        } catch (e) {
            log(`Encoder Error: ${e.message}`);
        }
    }
}

const homeduino = new Homeduino(options.serial_port, options.baud_rate);

// --- MQTT ---
const mqttUrl = `mqtt://${options.mqtt_broker}:${options.mqtt_port}`;
const mqttOptions = {
    username: options.mqtt_user,
    password: options.mqtt_password,
    clientId: 'homeduino_bridge_' + Math.random().toString(16).substr(2, 8)
};

log(`Connecting to MQTT: ${mqttUrl}`);
const mqttClient = mqtt.connect(mqttUrl, mqttOptions);

mqttClient.on('connect', () => {
    log('MQTT Connected');
    mqttClient.publish('homeduino/status', 'online', { retain: true });
    mqttClient.subscribe('homeduino/command/#');
    updateUIStatus();
});

mqttClient.on('error', (err) => {
    log(`MQTT Error: ${err.message}`);
    updateUIStatus();
});

mqttClient.on('close', () => {
    log('MQTT Connection Closed');
    updateUIStatus();
});

mqttClient.on('message', (topic, message) => {
    debug(`MQTT In: ${topic} -> ${message.toString()}`);
    // homeduino/command/protocol/uid
    const parts = topic.split('/');
    if (parts.length >= 4 && parts[1] === 'command') {
        const protocol = parts[2];
        const uid = parts[3];
        try {
            const payload = message.toString();
            // Payload could be "on", "off" or a JSON object
            let values = {};
            if (payload.toLowerCase() === 'on') values = { state: true };
            else if (payload.toLowerCase() === 'off') values = { state: false };
            else {
                try { values = JSON.parse(payload); } catch (e) { values = { state: payload }; }
            }
            
            // Extract ID from UID if possible or use from payload
            if (uid.startsWith('hd_' + protocol + '_')) {
                const idPart = uid.substring(('hd_' + protocol + '_').length);
                if (idPart !== 'fixed' && values.id === undefined) {
                    values.id = isNaN(idPart) ? idPart : parseInt(idPart);
                }
            }

            homeduino.send(protocol, values);
        } catch (e) {
            log(`Error processing MQTT command: ${e.message}`);
        }
    }
});

// --- Web Server & Socket.IO ---
const app = express();
const server = http.createServer(app);

// Get the Ingress path from headers if available (though usually handled by relative paths in UI)
app.use(express.static('public'));

const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: "*" }
});

function updateUIStatus() {
    io.emit('mqtt_status', { 
        connected: mqttClient.connected,
        broker: options.mqtt_broker
    });
}

io.on('connection', (socket) => {
    debug('UI Client Connected');
    updateUIStatus();
    
    socket.on('add_device', (data) => {
        const { protocol, values, type, name } = data;
        const uid = 'hd_' + protocol + '_' + (values.id !== undefined ? values.id : 'fixed');
        const basePath = `homeduino/${protocol}/${uid}`;
        
        const device = {
            identifiers: [uid],
            name: name,
            model: protocol,
            manufacturer: "Homeduino",
            sw_version: "3.8.0"
        };
        
        if (type === 'switch') {
            mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify({
                name: name,
                unique_id: uid,
                command_topic: `homeduino/command/${protocol}/${uid}`,
                state_topic: `${basePath}/state`,
                availability_topic: "homeduino/status",
                payload_on: "true",
                payload_off: "false",
                device: device
            }), { retain: true });
        } else {
            // Sensor discovery
            ['temperature', 'humidity', 'battery'].forEach(key => {
                if (values[key] !== undefined) {
                    mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_${key}/config`, JSON.stringify({
                        name: `${name} ${key}`,
                        unique_id: `${uid}_${key}`,
                        state_topic: `${basePath}/${key}`,
                        device_class: key === 'battery' ? 'battery' : (key === 'temperature' ? 'temperature' : 'humidity'),
                        unit_of_measurement: key === 'temperature' ? '°C' : '%',
                        availability_topic: "homeduino/status",
                        device: device
                    }), { retain: true });
                }
            });
        }
        log(`Discovery sent for ${name} (${uid})`);
        socket.emit('toast', `Discovery Sent for ${name}`);
    });

    socket.on('send_command', (data) => {
        const { protocol, values } = data;
        log(`Manual Send: ${protocol} ${JSON.stringify(values)}`);
        homeduino.send(protocol, values);
    });
});

homeduino.on('rfControlReceive', (event) => {
    const uid = 'hd_' + event.protocol + '_' + (event.values.id !== undefined ? event.values.id : 'fixed');
    const basePath = `homeduino/${event.protocol}/${uid}`;
    
    // Publish all received values to MQTT
    Object.keys(event.values).forEach(key => {
        mqttClient.publish(`${basePath}/${key}`, event.values[key].toString(), { retain: true });
    });
    
// Notify UI
    console.log(`Debug: Emitting signal to UI:`, JSON.stringify(event));
    io.emit('signal', { ...event, uid, basePath });
});

homeduino.on('error', (err) => {
    io.emit('status', { error: err });
});

homeduino.on('connected', () => {
    io.emit('status', { error: null });
});

// Start everything
homeduino.connect();
server.listen(8080, '0.0.0.0', () => {
    log('Bridge Server listening on port 8080');
});
