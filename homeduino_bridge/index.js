const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const serial = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
const parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" } });

const mqttClient = mqtt.connect('mqtt://core-mosquitto:1883');

serial.on('open', () => {
    console.log('Serial connected. Flushing buffer...');
    serial.write('\nRF receive 0\n');
});

parser.on('data', (line) => {
    console.log('Raw:', line);
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
                    // Sende an MQTT
                    results.forEach(res => {
                        mqttClient.publish(`homeduino/rf/${res.protocol}`, JSON.stringify(res.values), { retain: false });
                    });
                }
            }
        } catch (e) {
            console.error('Decode Error:', e.message);
        }
    }
});

server.listen(8080);
