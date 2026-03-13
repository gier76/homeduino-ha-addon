const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const EventEmitter = require('events');

// 1. Homeduino Bridge Class
class Homeduino extends EventEmitter {
  constructor(port, baudRate = 115200) {
    super();
    this.portPath = port;
    this.baudRate = baudRate;
    this.serial = null;
    this.parser = null;
    this.connected = false;
  }

  connect() {
    console.log(`Opening serial port ${this.portPath}...`);
    this.serial = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: true
    });

    this.parser = this.serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    this.serial.on('open', () => {
      console.log('Serial port opened.');
      this.connected = true;
      this.emit('connected');
      this.write('RF receive 0'); 
    });

    this.serial.on('error', (err) => {
      console.error('Serial Error:', err);
      this.emit('error', err);
    });

    this.parser.on('data', (line) => {
      line = line.trim();
      if (process.env.DEBUG || options.debug) console.log(`[Serial Raw]: "${line}"`);
      this.handleLine(line);
    });
  }

  handleLine(line) {
    if (line === 'ready') {
      console.log('Homeduino Arduino is ready.');
      this.write('RF receive 0');
      return;
    }

    if (line.startsWith('RF receive ')) {
      const parts = line.split(' ');
      const strSeq = parts.slice(2).join(' ');
      try {
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        this.decode(info.pulseLengths, info.pulses);
      } catch (e) {
        if (process.env.DEBUG) console.error('Decoding Error:', e.message);
      }
    }
  }

  decode(pulseLengths, pulses) {
    const results = rfcontrol.decodePulses(pulseLengths, pulses);
    if (results && results.length > 0) {
      for (const result of results) {
        this.emit('rfControlReceive', {
          protocol: result.protocol,
          values: result.values
        });
      }
    }
  }

  async send(protocol, values) {
    try {
      const result = rfcontrol.encodeMessage(protocol, values);
      if (result && result.pulseLengths && result.pulses) {
        const p = result.pulseLengths;
        const pStr = [p[0]||0, p[1]||0, p[2]||0, p[3]||0, p[4]||0, p[5]||0, p[6]||0, p[7]||0].join(' ');
        const command = `RF send 4 4 ${pStr} ${result.pulses}`;
        return this.write(command);
      }
    } catch (e) {
      throw new Error(`Encoding failed: ${e.message}`);
    }
  }

  write(data) {
    if (!this.connected) return;
    return new Promise((resolve, reject) => {
      this.serial.write(data + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// 2. Read configuration
let options = {};
try {
  if (fs.existsSync('/data/options.json')) {
    options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  }
} catch (e) {}

const SERIAL_PORT = options.serial_port || '/dev/ttyUSB0';
const MQTT_HOST = options.mqtt_broker || 'core-mosquitto';
const MQTT_PORT = options.mqtt_port || 1883;
const MQTT_USER = options.mqtt_user || '';
const MQTT_PASS = options.mqtt_password || '';
const MQTT_URL = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;

// 3. Initialize Homeduino
const homeduino = new Homeduino(SERIAL_PORT);
let lastError = null;

homeduino.on('connected', () => {
  lastError = null;
  io.emit('status', { connected: true });
});

homeduino.on('error', (err) => {
  lastError = err.message;
  io.emit('status', { connected: false, error: err.message });
});

// 4. Initialize MQTT
const mqttOptions = {
  reconnectPeriod: 5000,
  will: { topic: 'homeduino/status', payload: 'offline', retain: true, qos: 1 }
};
if (MQTT_USER) mqttOptions.username = MQTT_USER;
if (MQTT_PASS) mqttOptions.password = MQTT_PASS;

const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

mqttClient.on('connect', () => {
  console.log('MQTT Connected');
  mqttClient.publish('homeduino/status', 'online', { retain: true });
  mqttClient.subscribe('homeduino/command/#');
  io.emit('mqtt_status', { connected: true });
});

mqttClient.on('message', (topic, message) => {
  if (topic.startsWith('homeduino/command/')) {
    const protocol = topic.split('/').pop();
    try {
      const values = JSON.parse(message.toString());
      if (values.state === 'on') values.state = true;
      if (values.state === 'off') values.state = false;
      homeduino.send(protocol, values).catch(console.error);
    } catch (e) { console.error('MQTT Parse Error', e); }
  }
});

// 5. Web UI & Discovery
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function getDeviceMeta(protocol, values) {
  const id = values.id !== undefined ? values.id : (values.channel !== undefined ? values.channel : 0);
  const channel = values.channel !== undefined ? values.channel : 0;
  const unit = values.unit !== undefined ? values.unit : 0;
  
  // Create a truly unique identifier string
  const uid = `hd_${protocol}_i${id}_c${channel}_u${unit}`.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  // Exclusive topic for this specific device
  const topic = `homeduino/stat/${uid}`;
  
  return { id, channel, unit, uid, topic };
}

io.on('connection', (socket) => {
  socket.emit('status', { connected: homeduino.connected, error: lastError });
  socket.emit('mqtt_status', { connected: mqttClient.connected });

  socket.on('send_command', (data) => {
    homeduino.send(data.protocol, data.values).catch(err => socket.emit('error', err.message));
  });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name } = data;
    const meta = getDeviceMeta(protocol, values);
    
    console.log(`[Discovery] Adding ${type} ${meta.uid} to HA`);

    const commonDevice = {
      identifiers: [meta.uid],
      name: name || `Homeduino ${protocol} ${meta.id}`,
      model: protocol,
      manufacturer: "Homeduino Bridge",
      sw_version: "3.3.2"
    };

    if (type === 'switch' || values.state !== undefined) {
      const payload = {
        name: null,
        unique_id: `${meta.uid}_sw`,
        command_topic: `homeduino/command/${protocol}`,
        payload_on: JSON.stringify({ ...values, id: meta.id, channel: meta.channel, unit: meta.unit, state: 'on' }),
        payload_off: JSON.stringify({ ...values, id: meta.id, channel: meta.channel, unit: meta.unit, state: 'off' }),
        state_topic: meta.topic,
        value_template: "{{ value_json.state }}",
        availability_topic: "homeduino/status",
        device: commonDevice
      };
      mqttClient.publish(`homeassistant/switch/homeduino/${meta.uid}/config`, JSON.stringify(payload), { retain: true });
    } else {
      const sensors = [];
      const isWeather = ['weather', 'mandolyn', 'oregon', 'cresta'].some(p => protocol.includes(p));
      
      if (values.temperature !== undefined || isWeather) 
        sensors.push({ key: 'temperature', unit: '°C', class: 'temperature' });
      if (values.humidity !== undefined || values.hum !== undefined || isWeather) 
        sensors.push({ key: 'humidity', unit: '%', class: 'humidity' });
      if (values.battery !== undefined) 
        sensors.push({ key: 'battery', unit: '%', class: 'battery' });

      sensors.forEach(s => {
        const payload = {
          name: s.key.charAt(0).toUpperCase() + s.key.slice(1),
          unique_id: `${meta.uid}_${s.key}`,
          state_topic: meta.topic,
          unit_of_measurement: s.unit,
          device_class: s.class,
          // Simple template as topic is exclusive
          value_template: `{{ value_json.${s.key} if value_json.${s.key} is defined else (value_json.hum if '${s.key}' == 'humidity' and value_json.hum is defined else states('sensor.${meta.uid}_${s.key}')) }}`,
          availability_topic: "homeduino/status",
          device: commonDevice
        };
        mqttClient.publish(`homeassistant/sensor/homeduino/${meta.uid}_${s.key}/config`, JSON.stringify(payload), { retain: true });
      });
    }
    socket.emit('toast', 'Registered unique device in HA');
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  const meta = getDeviceMeta(event.protocol, event.values);
  const data = { ...event.values };
  
  // Normalize state
  if (data.state === true || data.state === 1 || data.state === 'on') data.state = 'on';
  else if (data.state === false || data.state === 0 || data.state === 'off') data.state = 'off';

  // Include IDs in published JSON for template safety
  data.hd_uid = meta.uid;

  mqttClient.publish(meta.topic, JSON.stringify(data));
  io.emit('signal', { timestamp: new Date().toISOString(), protocol: event.protocol, values: event.values, uid: meta.uid });
});

server.listen(8080);
homeduino.connect();
