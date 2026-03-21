const { SerialPort } = require('serialport');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

let options = { serial_port: "/dev/ttyUSB0", baud_rate: 115200, mqtt_broker: "core-mosquitto", mqtt_port: 1883, mqtt_user: "", mqtt_password: "", debug: true };
if (fs.existsSync('/data/options.json')) {
    try { options = { ...options, ...JSON.parse(fs.readFileSync('/data/options.json', 'utf8')) }; } catch (e) { console.error(e); }
}

let serial;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
} catch (err) { console.error(err); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" }, transports: ["polling", "websocket"] });
app.use(express.static('public'));

const mqttClient = mqtt.connect(`mqtt://${options.mqtt_broker}:${options.mqtt_port}`, { username: options.mqtt_user, password: options.mqtt_password });

// --- Humidity Decoder (v4.8.0) ---
function extractHumidity(bits) {
    if (!bits || bits.length < 50) return null;
    try {
        // Bits 40-47 enthalten die Feuchtigkeit
        const humBits = bits.substring(40, 48).replace(/2/g, '1');
        const hum = parseInt(humBits, 2);
        return (hum > 0 && hum <= 100) ? hum : null;
    } catch(e) { return null; }
}

// --- Serial Handler ---
let buffer = '';
if (serial) {
    serial.on('open', () => { 
        setInterval(() => serial.write('RF receive 0\n'), 5000); 
    });
    
    serial.on('data', (data) => {
        buffer += data.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();
            if (line.includes('RF receive ') || line.match(/^[012\s]+$/)) {
                if (line.startsWith('RF receive ')) {
                    this.currentSeq = line;
                } else if (this.currentSeq) {
                    this.currentSeq += line;
                    if (this.currentSeq.endsWith('03')) {
                        processSignal(this.currentSeq);
                        this.currentSeq = '';
                    }
                }
            }
        }
    });
}

function processSignal(line) {
    try {
        const parts = line.split(' ').slice(2);
        const bitStream = parts.join('');
        
        // Manual Weather2 Decoding (Simple Temp/Hum Logic)
        const tempBits = bitStream.substring(24, 36).replace(/2/g, '1');
        const temp = parseInt(tempBits, 2) / 10;
        const hum = extractHumidity(bitStream);
        
        const data = { temperature: temp, humidity: hum, raw: bitStream };
        const uid = 'hd_weather2_' + bitStream.substring(0, 10);
        
        mqttClient.publish(`homeduino/weather2/${uid}/temperature`, temp.toString(), { retain: true });
        if (hum) mqttClient.publish(`homeduino/weather2/${uid}/humidity`, hum.toString(), { retain: true });
        
        io.emit('signal', { protocol: 'weather2', values: data, uid: uid });
    } catch (e) { console.error(e); }
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.8.0 (Humidity Fix)'));
