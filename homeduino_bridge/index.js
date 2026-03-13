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
    const parts = topic.split('/');
    const protocol = parts[2];
    try {
      const values = JSON.parse(message.toString());
      if (values.state === 'on') values.state = true;
      if (values.state === 'off') values.state = false;
      homeduino.send(protocol, values).catch(console.error);
    } catch (e) { console.error('MQTT Parse Error', e); }
  }
});

// 5. Web UI & Logic Functions
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function getIdentity(protocol, values) {
  // System ID: Higher level grouping (House, Address, Code)
  const systemId = values.housecode || values.house || values.address || values.rolling_code || values.systemcode || values.id || '0';
  // Device ID: Lower level grouping (Channel, Unit, Button)
  const deviceId = values.channel || values.unit || (values.id !== systemId ? values.id : null) || values.button || '0';
  
  const basePath = `${protocol}/${systemId}/${deviceId}`;
  const uid = `hd_${protocol}_s${systemId}_d${deviceId}`.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  
  return { systemId, deviceId, basePath, uid };
}

io.on('connection', (socket) => {
  socket.emit('status', { connected: homeduino.connected, error: lastError });
  socket.emit('mqtt_status', { connected: mqttClient.connected });

  socket.on('send_command', (data) => {
    homeduino.send(data.protocol, data.values).catch(err => socket.emit('error', err.message));
  });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name } = data;
    const { basePath, uid } = getIdentity(protocol, values);
    
    console.log(`[Discovery] Adding ${type} ${uid} at homeduino/${basePath}`);

    const commonDevice = {
      identifiers: [uid],
      name: name || `Homeduino ${protocol} ${uid.split('_').pop()}`,
      model: protocol,
      manufacturer: "Homeduino Bridge",
      sw_version: "3.3.7"
    };

    if (type === 'switch' || values.state !== undefined) {
      const payload = {
        name: null,
        unique_id: `${uid}_sw`,
        command_topic: `homeduino/command/${protocol}`,
        payload_on: JSON.stringify({ ...values, state: 'on' }),
        payload_off: JSON.stringify({ ...values, state: 'off' }),
        state_topic: `homeduino/${basePath}/state`,
        availability_topic: "homeduino/status",
        device: commonDevice
      };
      mqttClient.publish(`homeassistant/switch/homeduino/${uid}/config`, JSON.stringify(payload), { retain: true });
    } else {
      const keys = Object.keys(values).filter(k => 
        ['temperature', 'humidity', 'hum', 'battery', 'lowbattery'].includes(k)
      );
      
      // Ensure we have at least temp and humidity for weather sensors
      if (['weather', 'mandolyn', 'oregon', 'cresta', 'weather2'].some(p => protocol.includes(p))) {
        if (!keys.includes('temperature')) keys.push('temperature');
        if (!keys.includes('humidity')) keys.push('humidity');
      }

      keys.forEach(key => {
        let haKey = key === 'hum' ? 'humidity' : key;
        const payload = {
          name: haKey.charAt(0).toUpperCase() + haKey.slice(1),
          unique_id: `${uid}_${haKey}`,
          state_topic: `homeduino/${basePath}/${haKey}`,
          unit_of_measurement: haKey === 'temperature' ? '°C' : (haKey === 'humidity' ? '%' : (haKey === 'battery' ? '%' : null)),
          device_class: haKey === 'temperature' ? 'temperature' : (haKey === 'humidity' ? 'humidity' : (haKey === 'battery' ? 'battery' : null)),
          availability_topic: "homeduino/status",
          device: commonDevice
        };
        mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_${haKey}/config`, JSON.stringify(payload), { retain: true });
      });
    }
    socket.emit('toast', 'Device Hierarchical Discovery Sent');
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  const { basePath, uid } = getIdentity(event.protocol, event.values);
  const v = { ...event.values };

  // Publish each value to its own topic
  Object.keys(v).forEach(key => {
    let value = v[key];
    let topicKey = key;

    // Normalizations
    if (key === 'state') {
      value = (value === true || value === 1 || value === 'on') ? 'on' : 'off';
    }
    if (key === 'hum') topicKey = 'humidity';

    // Filter data fields for MQTT sub-topics
    if (['temperature', 'humidity', 'battery', 'state', 'lowbattery', 'contact'].includes(topicKey)) {
      mqttClient.publish(`homeduino/${basePath}/${topicKey}`, value.toString(), { retain: true });
    }
  });

  if (options.debug) console.log(`[RF] ${uid} -> homeduino/${basePath}`);
  
  io.emit('signal', { 
    timestamp: new Date().toISOString(), 
    protocol: event.protocol, 
    values: event.values, 
    uid: uid 
  });
});

server.listen(8080);
homeduino.connect();
