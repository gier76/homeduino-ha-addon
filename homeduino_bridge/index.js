const { SerialPort } = require('serialport');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const fs = require('fs');

let options = { serial_port: "/dev/ttyUSB0", baud_rate: 115200 };
if (fs.existsSync('/data/options.json')) {
    try { options = { ...options, ...JSON.parse(fs.readFileSync('/data/options.json', 'utf8')) }; } catch (e) {}
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: "*" }, transports: ["polling", "websocket"] });
app.use(express.static('public'));

let serial;
try {
    serial = new SerialPort({ path: options.serial_port, baudRate: parseInt(options.baud_rate) });
} catch (err) { console.error(err); }

if (serial) {
    serial.on('open', () => { 
        console.log('--- SERIAL PORT OPENED ---');
        io.emit('log', 'Serial Port Opened');
        // Sende Befehl alle 5 Sekunden
        setInterval(() => {
            serial.write('RF receive 0\n');
        }, 5000);
    });
    
    serial.on('data', (data) => {
        const ascii = data.toString('ascii');
        console.log(`[DEBUG RAW]: ${ascii}`);
        io.emit('log', `RAW: ${ascii}`);
    });

    serial.on('error', (err) => {
        console.error('Serial Error:', err.message);
        io.emit('log', `Serial Error: ${err.message}`);
    });
}

server.listen(8080, '0.0.0.0', () => console.log('Bridge Server v4.7.1 (Cyclic Trigger)'));
