const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const EventEmitter = require('events');

function logToFile(msg) {
  const timestamp = new Date().toISOString();
  try { fs.appendFileSync('bridge_debug.log', `[${timestamp}] ${msg}\n`); } catch (e) {}
  console.log(`[${timestamp}] ${msg}`);
}

class Homeduino extends EventEmitter {
  constructor(port, baudRate = 115200) {
    super();
    this.serial = new SerialPort({ path: port, baudRate: baudRate, autoOpen: false, lock: false });
    this.serial.open((err) => {
        this.emit('connected');
        this.write('RF receive 0');
    });
    this.parser = this.serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    this.serial.on('data', (data) => this.handleLine(data.toString()));
  }

  handleLine(line) {
    line = line.trim();
    if (line === 'ready') { this.write('RF receive 0'); return; }
    if (line.startsWith('RF receive ')) {
      const strSeq = line.split(' ').slice(2).join(' ');
      const pulses = strSeq.split(' ').filter(p => p !== '0');
      if (pulses.length < 6) return;
      try {
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        if (info && Array.isArray(info.pulseLengths)) {
            const results = rfcontrol.decodePulses(info.pulseLengths, info.pulses);
            if (Array.isArray(results)) {
              results.forEach(res => {
                  if (res && res.values && res.protocol) {
                    this.emit('rfControlReceive', { protocol: res.protocol, values: res.values, raw: strSeq });
                  }
              });
            }
        }
      } catch (e) { logToFile(`[Decoder Error] ${e.message}`); }
    }
  }

  async send(protocol, values) {
    const result = rfcontrol.encodeMessage(protocol, values);
    if (!result) return;
    this.serial.write(`RF send 4 ${result.pulseLengths.length} ${result.pulseLengths.join(' ')} ${result.pulses}\n`);
  }
}

const homeduino = new Homeduino('/dev/ttyUSB0', 115200);
const mqttClient = mqtt.connect('mqtt://core-mosquitto:1883');

mqttClient.on('connect', () => {
    mqttClient.publish('homeduino/status', 'online', { retain: true });
    mqttClient.subscribe('homeduino/command/#');
});

const io = new Server(http.createServer(express().use(express.static('public'))).listen(8080));

io.on('connection', (socket) => {
  socket.on('add_device', (data) => {
    const { protocol, values, type, name, raw } = data;
    const uid = 'hd_' + protocol + '_' + (values.id || 'fixed');
    const basePath = `homeduino/${protocol}/${uid}`;
    
    const device = { identifiers: [uid], name: name, model: protocol, manufacturer: "Homeduino", sw_version: "3.8.0" };
    
    if (type === 'switch') {
      mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify({
        name: name, unique_id: uid, command_topic: `homeduino/command/${protocol}/${uid}`,
        state_topic: `${basePath}/state`, availability_topic: "homeduino/status", device: device
      }), { retain: true });
    } else {
        ['temperature', 'humidity', 'battery'].forEach(key => {
            if (values[key] !== undefined) {
              mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_${key}/config`, JSON.stringify({
                name: `${name} ${key}`, unique_id: `${uid}_${key}`, state_topic: `${basePath}/${key}`,
                device_class: key, unit_of_measurement: key === 'temperature' ? '°C' : (key === 'humidity' ? '%' : '%'),
                availability_topic: "homeduino/status", device: device
              }), { retain: true });
            }
        });
    }
    logToFile(`[Discovery] Sent for ${uid}`);
    socket.emit('toast', 'Discovery Sent');
  });
});

homeduino.on('rfControlReceive', (event) => {
  const uid = 'hd_' + event.protocol + '_' + (event.values.id || 'fixed');
  const basePath = `homeduino/${event.protocol}/${uid}`;
  Object.keys(event.values).forEach(key => {
    mqttClient.publish(`${basePath}/${key}`, event.values[key].toString(), { retain: true });
  });
  io.emit('signal', { ...event, uid, basePath });
});

homeduino.connect();
