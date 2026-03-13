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
} catch (e) {
  console.warn('Using defaults.');
}

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

io.on('connection', (socket) => {
  socket.emit('status', { connected: homeduino.connected, error: lastError });
  socket.emit('mqtt_status', { connected: mqttClient.connected });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name } = data;
    const id = values.id !== undefined ? values.id : (values.channel !== undefined ? values.channel : 0);
    const unit = values.unit !== undefined ? values.unit : 0;
    
    // Strict Device UID
    const deviceUid = `homeduino_${protocol}_${id}_${unit}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const stateTopic = `homeduino/received/${protocol}/${id}/${unit}`;
    
    const commonDevice = {
      identifiers: [deviceUid],
      name: name || `Homeduino ${protocol} ${id}`,
      model: protocol,
      manufacturer: "Homeduino Bridge",
      sw_version: "3.3.0"
    };

    if (type === 'switch' || values.state !== undefined) {
      const payload = {
        name: null, // Sub-entities take device name if null
        unique_id: `${deviceUid}_switch`,
        command_topic: `homeduino/command/${protocol}`,
        payload_on: JSON.stringify({ ...values, id, unit, state: 'on' }),
        payload_off: JSON.stringify({ ...values, id, unit, state: 'off' }),
        state_topic: stateTopic,
        value_template: "{{ value_json.state }}",
        availability_topic: "homeduino/status",
        device: commonDevice
      };
      mqttClient.publish(`homeassistant/switch/homeduino/${deviceUid}/config`, JSON.stringify(payload), { retain: true });
    } else {
      const sensors = [];
      if (values.temperature !== undefined) sensors.push({ key: 'temperature', unit: '°C', class: 'temperature' });
      if (values.humidity !== undefined) sensors.push({ key: 'humidity', unit: '%', class: 'humidity' });
      if (values.battery !== undefined) sensors.push({ key: 'battery', unit: '%', class: 'battery' });

      sensors.forEach(s => {
        const payload = {
          name: s.key.charAt(0).toUpperCase() + s.key.slice(1),
          unique_id: `${deviceUid}_${s.key}`,
          state_topic: stateTopic,
          unit_of_measurement: s.unit,
          device_class: s.class,
          value_template: `{{ value_json.${s.key} }}`,
          availability_topic: "homeduino/status",
          device: commonDevice
        };
        mqttClient.publish(`homeassistant/sensor/homeduino/${deviceUid}_${s.key}/config`, JSON.stringify(payload), { retain: true });
      });
    }
    socket.emit('toast', 'Device added to Home Assistant');
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  const v = { ...event.values };
  const id = v.id !== undefined ? v.id : (v.channel !== undefined ? v.channel : 0);
  const unit = v.unit !== undefined ? v.unit : 0;
  
  if (v.state === true || v.state === 1 || v.state === 'on') v.state = 'on';
  else if (v.state === false || v.state === 0 || v.state === 'off') v.state = 'off';

  const topic = `homeduino/received/${event.protocol}/${id}/${unit}`;
  mqttClient.publish(topic, JSON.stringify(v));
  io.emit('signal', { timestamp: new Date().toISOString(), protocol: event.protocol, values: event.values });
});

server.listen(8080);
homeduino.connect();
