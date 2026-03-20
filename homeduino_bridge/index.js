const fs = require('fs');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// --- Configuration Handling ---
let options = {
    serial_port: "/dev/ttyUSB0",
    baud_rate: 115200,
    mqtt_broker: "core-mosquitto",
    mqtt_port: 1883,
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

// --- Web Server & Socket.IO ---
const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" } });

// --- MQTT ---
const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`);
mqttClient.on('connect', () => console.log('MQTT Connected'));
mqttClient.on('error', (err) => console.error('MQTT Error:', err.message));

// --- Serial Port Handling ---
let serial = null;
let parser = null;

function connectSerial() {
    console.log(`Attempting to connect to serial port: ${options.serial_port}`);
    
    serial = new SerialPort({ 
        path: options.serial_port, 
        baudRate: parseInt(options.baud_rate),
        autoOpen: false 
    });

    serial.open((err) => {
        if (err) {
            console.error(`Serial Error: ${err.message}`);
            SerialPort.list().then(ports => {
                console.log('Available ports:');
                ports.forEach(p => console.log(`- ${p.path} (${p.manufacturer || 'unknown'})`));
            });
            console.log('Retrying in 10 seconds...');
            setTimeout(connectSerial, 10000);
            return;
        }

        console.log('Serial connected. Initializing RF...');
        parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
        
        // Give Arduino time to boot, then start receiving
        setTimeout(() => {
            serial.write('\nRF receive 0\n');
        }, 3000);

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
                                mqttClient.publish(`homeduino/rf/${res.protocol}`, JSON.stringify(res.values));
                            });
                        }
                    }
                } catch (e) {
                    if (options.debug) console.error('Decode Error:', e.message);
                }
            }
        });
    });

    serial.on('error', (err) => {
        console.error('Serial fatal error:', err.message);
        setTimeout(connectSerial, 10000);
    });

    serial.on('close', () => {
        console.log('Serial port closed. Retrying...');
        setTimeout(connectSerial, 10000);
    });
}

// Start everything
connectSerial();
server.listen(8080, '0.0.0.0', () => {
    console.log('Bridge Server listening on port 8080');
});
