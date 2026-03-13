const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs'); // This is an object with methods
const EventEmitter = require('events');

// 1. Homeduino Bridge Class (Modernized)
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
      // Start receiving on pin 0 (common for most Homeduino setups)
      console.log('Initializing RF reception on pin 0...');
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
      console.log('Homeduino Arduino is ready. Re-initializing reception...');
      this.write('RF receive 0');
      return;
    }

    if (line.startsWith('RF receive ')) {
      console.log(`[RF Data]: Incoming raw pulses detected: ${line}`);
      const parts = line.split(' ');
      const strSeq = parts.slice(2).join(' ');
      try {
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        this.decode(info.pulseLengths, info.pulses);
      } catch (e) {
        if (process.env.DEBUG) console.error('Decoding Error:', e.message);
      }
    } else if (line.startsWith('PULSES ')) {
      if (process.env.DEBUG) console.log('Raw pulses received:', line);
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
    console.log(`Encoding command: ${protocol}`, values);
    try {
      const result = rfcontrol.encodeMessage(protocol, values);
      if (result && result.pulseLengths && result.pulses) {
        const p = result.pulseLengths;
        const pStr = [p[0]||0, p[1]||0, p[2]||0, p[3]||0, p[4]||0, p[5]||0, p[6]||0, p[7]||0].join(' ');
        const command = `RF send 4 4 ${pStr} ${result.pulses}`;
        return this.write(command);
      }
    } catch (e) {
      throw new Error(`Encoding failed for ${protocol}: ${e.message}`);
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
  console.warn('Could not read /data/options.json, using defaults.');
}

const SERIAL_PORT = options.serial_port || process.env.SERIAL_PORT || '/dev/ttyUSB0';
const MQTT_HOST = options.mqtt_broker && options.mqtt_broker !== 'localhost' ? options.mqtt_broker : (process.env.MQTT_HOST || 'core-mosquitto');
const MQTT_PORT = options.mqtt_port || process.env.MQTT_PORT || 1883;
const MQTT_USER = options.mqtt_user || process.env.MQTT_USER || '';
const MQTT_PASS = options.mqtt_password || process.env.MQTT_PASSWORD || '';
const MQTT_PROTOCOL = (MQTT_PORT == 8883) ? 'mqtts' : 'mqtt';

const MQTT_URL = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`;

// 3. Initialize Homeduino
const homeduino = new Homeduino(SERIAL_PORT);
let lastError = null;

homeduino.on('connected', () => {
  console.log('Homeduino connected!');
  lastError = null;
  io.emit('status', { connected: true });
});

homeduino.on('error', (err) => {
  console.error('Homeduino Error:', err.message);
  lastError = err.message;
  io.emit('status', { connected: false, error: err.message });
});

// 4. Initialize MQTT
const mqttOptions = {
  reconnectPeriod: 5000,
  connectTimeout: 30 * 1000,
  will: {
    topic: 'homeduino/status',
    payload: 'offline',
    retain: true,
    qos: 1
  }
};

if (MQTT_USER && MQTT_USER.trim() !== '') {
  mqttOptions.username = MQTT_USER;
}
if (MQTT_PASS && MQTT_PASS.trim() !== '') {
  mqttOptions.password = MQTT_PASS;
}

console.log(`Connecting to MQTT broker: ${MQTT_URL} ...`);
const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

mqttClient.on('connect', () => {
  console.log('MQTT connected successfully!');
  mqttClient.publish('homeduino/status', 'online', { retain: true });
  
  setInterval(() => {
    mqttClient.publish('homeduino/status/heartbeat', new Date().toISOString());
  }, 60000);

  io.emit('mqtt_status', { connected: true });
  mqttClient.subscribe('homeduino/command/#', (err) => {
    if (err) console.error('MQTT subscribe error:', err);
    else console.log('MQTT subscribed to homeduino/command/#');
  });
});

mqttClient.on('reconnect', () => {
  console.log('MQTT reconnecting...');
  io.emit('mqtt_status', { connected: false, message: 'Reconnecting...' });
});

mqttClient.on('close', () => {
  console.log('MQTT connection closed.');
  io.emit('mqtt_status', { connected: false });
});

mqttClient.on('offline', () => {
  console.log('MQTT offline.');
  io.emit('mqtt_status', { connected: false, message: 'Offline' });
});

mqttClient.on('error', (err) => {
  console.error('MQTT Connection Error:', err.message);
  io.emit('mqtt_status', { connected: false, error: err.message });
});

mqttClient.on('message', (topic, message) => {
  if (topic === 'homeduino/test') {
    mqttClient.publish('homeduino/status/test_response', 'I am alive: ' + new Date().toISOString());
    return;
  }

  if (topic.startsWith('homeduino/command/')) {
    const protocol = topic.split('/').pop();
    try {
      const values = JSON.parse(message.toString());
      if (values.state === 'on') values.state = true;
      if (values.state === 'off') values.state = false;

      homeduino.send(protocol, values).catch(err => {
        console.error('Send Error:', err);
      });
    } catch (e) {
      console.error('Failed to parse MQTT message:', e);
    }
  }
});

// 5. Web UI (Ingress)
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

io.on('connection', (socket) => {
  socket.emit('status', { connected: homeduino.connected, error: lastError });
  socket.emit('mqtt_status', { connected: mqttClient.connected });

  socket.on('send_command', (data) => {
    homeduino.send(data.protocol, data.values).catch(err => socket.emit('error', err.message));
  });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name } = data;
    const deviceId = values.id !== undefined ? values.id : (values.channel !== undefined ? values.channel : 0);
    const deviceUnit = values.unit !== undefined ? values.unit : 0;
    const uniqueBase = `homeduino_${protocol}_${deviceId}_${deviceUnit}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    const deviceStateTopic = `homeduino/received/${protocol}/${deviceId}/${deviceUnit}`;
    console.log(`Adding device to HA: ${type} (${protocol}) ID:${deviceId} Unit:${deviceUnit}`);

    if (type === 'switch' || (!type && values.state !== undefined)) {
      const uniqueId = uniqueBase;
      const payload = {
        name: name || `Homeduino Switch ${deviceId}:${deviceUnit}`,
        unique_id: uniqueId,
        command_topic: `homeduino/command/${protocol}`,
        payload_on: JSON.stringify({ ...values, id: deviceId, unit: deviceUnit, state: 'on' }),
        payload_off: JSON.stringify({ ...values, id: deviceId, unit: deviceUnit, state: 'off' }),
        state_topic: deviceStateTopic,
        value_template: "{{ value_json.state }}",
        state_on: 'on',
        state_off: 'off',
        device: { 
          identifiers: [uniqueId], 
          name: name || `Homeduino Switch ${deviceId}`, 
          model: protocol, 
          manufacturer: "Homeduino Bridge",
          sw_version: "3.2.9"
        }
      };
      mqttClient.publish(`homeassistant/switch/homeduino/${uniqueId}/config`, JSON.stringify(payload), { retain: true });
      socket.emit('toast', `Switch added: ${name || uniqueId}`);
    } else {
      const sensors = [];
      const hasTemp = values.temperature !== undefined || ['weather', 'mandolyn', 'oregon', 'cresta'].some(p => protocol.includes(p));
      const hasHum = values.humidity !== undefined || ['weather', 'mandolyn', 'oregon', 'cresta'].some(p => protocol.includes(p));
      const hasBatt = values.battery !== undefined;

      if (hasTemp) sensors.push({ key: 'temperature', unit: '°C', class: 'temperature' });
      if (hasHum) sensors.push({ key: 'humidity', unit: '%', class: 'humidity' });
      if (hasBatt) sensors.push({ key: 'battery', unit: '%', class: 'battery' });

      sensors.forEach(s => {
        const uniqueId = `${uniqueBase}_${s.key}`;
        const payload = {
          name: `${name || protocol + ' ' + deviceId} ${s.key.charAt(0).toUpperCase() + s.key.slice(1)}`,
          unique_id: uniqueId,
          state_topic: deviceStateTopic,
          unit_of_measurement: s.unit,
          device_class: s.class,
          value_template: `{{ value_json.${s.key} if value_json.${s.key} is defined else states('sensor.${uniqueId}') }}`,
          device: { 
            identifiers: [uniqueBase], 
            name: name || `Homeduino Sensor ${deviceId}`, 
            model: protocol, 
            manufacturer: "Homeduino Bridge",
            sw_version: "3.2.9"
          }
        };
        mqttClient.publish(`homeassistant/sensor/homeduino/${uniqueId}/config`, JSON.stringify(payload), { retain: true });
      });
      socket.emit('toast', `Weather sensors added: ${name || uniqueBase}`);
    }
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  const mqttValues = { ...event.values };
  const id = mqttValues.id !== undefined ? mqttValues.id : (mqttValues.channel !== undefined ? mqttValues.channel : 0);
  const unit = mqttValues.unit !== undefined ? mqttValues.unit : 0;
  
  mqttValues.id = id;
  mqttValues.unit = unit;

  if (mqttValues.state === true || mqttValues.state === 1 || mqttValues.state === 'on') mqttValues.state = 'on';
  else if (mqttValues.state === false || mqttValues.state === 0 || mqttValues.state === 'off') mqttValues.state = 'off';

  const deviceTopic = `homeduino/received/${event.protocol}/${id}/${unit}`;
  mqttClient.publish(deviceTopic, JSON.stringify(mqttValues));
  io.emit('signal', { timestamp: new Date().toISOString(), protocol: event.protocol, values: event.values });
});

const PORT = 8080;
server.listen(PORT, () => console.log(`Web UI listening on port ${PORT}`));

homeduino.connect();
