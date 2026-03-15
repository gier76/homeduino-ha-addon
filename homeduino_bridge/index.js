const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const EventEmitter = require('events');

// Global state store
const deviceStates = {}; 

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
      if (options.debug) console.log(`[Serial Raw]: "${line}"`);
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
      if (options.debug) console.log(`[RF Receive Raw]: ${strSeq}`);
      try {
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        this.decode(info.pulseLengths, info.pulses, strSeq);
      } catch (e) {
        if (options.debug) console.error('Decoding Error:', e.message);
      }
    }
  }

  decode(pulseLengths, pulses, raw) {
    const results = rfcontrol.decodePulses(pulseLengths, pulses);
    if (results && results.length > 0) {
      for (const result of results) {
        if (options.debug) {
          console.log(`[RF Decode]: Protocol=${result.protocol} | Values=${JSON.stringify(result.values)}`);
        }
        this.emit('rfControlReceive', {
          protocol: result.protocol,
          values: result.values,
          raw: raw
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
let options = { debug: true }; // Default to true for better troubleshooting
try {
  if (fs.existsSync('/data/options.json')) {
    const userOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    options = { ...options, ...userOptions };
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

function getHierarchy(protocol, values, raw) {
  // Telemetry fields (data that changes frequently)
  const telemetry = ['temperature', 'humidity', 'hum', 'battery', 'lowbattery', 'state', 'contact', 'hd_uid', 'timestamp', 'lux', 'pressure', 'rain'];
  
  // Potential Identification fields (data that identifies the device)
  const idFields = [
    'id', 'channel', 'rolling_code', 'address', 'house', 'unit', 'systemcode', 
    'knocode', 'all', 'group', 'housecode', 'unitcode', 'switch', 'button',
    'sensorId', 'id1', 'id2', 'random', 'code', 'device', 'sid', 'did', 'uuid', 'mac'
  ];

  let systemId = 'unk';
  let deviceId = 'unk';

  // 1. Try to find IDs in designated idFields
  const foundIds = [];
  for (const f of idFields) {
    if (values[f] !== undefined && values[f] !== null) {
      foundIds.push(values[f].toString());
    }
  }

  if (foundIds.length > 0) {
    systemId = foundIds[0];
    if (foundIds.length > 1) {
      deviceId = foundIds[1];
    }
  }

  // 2. Fallback: Use ANY field that is NOT telemetry if we still have 'unk'
  if (systemId === 'unk') {
    const others = Object.keys(values)
      .filter(k => !telemetry.includes(k) && !idFields.includes(k))
      .sort();
    
    if (others.length > 0) {
      systemId = values[others[0]].toString();
      if (others.length > 1) {
        deviceId = values[others[1]].toString();
      }
    }
  }

  // 3. Last Resort: Use a hash of the raw pulses if available
  if (systemId === 'unk' && deviceId === 'unk' && raw) {
    // We only hash the start of the sequence part of the raw signal.
    // Raw signal format: "P1 P2 P3 P4 P5 P6 P7 P8 SYMBOL_SEQ"
    // The symbol sequence contains ID + DATA. By hashing only the first part of it,
    // we have a better chance of hitting the ID but not the changing data (temp/hum).
    const parts = raw.split(' ');
    const symbolSeq = parts[parts.length - 1] || "";
    
    // Use first 20 symbols for ID hashing (usually enough for ID/Channel)
    const stablePart = symbolSeq.substring(0, 20);
    
    let hash = 0;
    for (let i = 0; i < stablePart.length; i++) {
        hash = ((hash << 5) - hash) + stablePart.charCodeAt(i);
        hash |= 0;
    }
    systemId = 'raw' + Math.abs(hash).toString(16).substring(0, 4);
    deviceId = 'fixed'; // We use 'fixed' to avoid new device per sequence length change
  }

  const uidSuffix = `${systemId}_${deviceId}`;
  const uid = `hd_${protocol}_${uidSuffix}`.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const basePath = `${protocol}/${systemId}/${deviceId}`;
  
  // Log final hierarchy decision
  if (options.debug) {
    console.log(`[Hierarchy Discovery] Protocol: ${protocol} | UID: ${uid} | System: ${systemId} | Device: ${deviceId}`);
  }

  return { uid, basePath, systemId, deviceId };
}

io.on('connection', (socket) => {
  if (options.debug) console.log('New Socket.io connection');
  socket.emit('status', { connected: homeduino.connected, error: lastError });
  socket.emit('mqtt_status', { connected: mqttClient.connected });

  socket.on('send_command', (data) => {
    homeduino.send(data.protocol, data.values).catch(err => socket.emit('error', err.message));
  });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name, raw } = data;
    const { uid, basePath } = getHierarchy(protocol, values, raw);
    
    console.log(`[Discovery] Adding ${type} ${uid} to HA at homeduino/${basePath}`);
// ... rest of the handler (omitted for brevity in replace, but I will provide full next)

    const commonDevice = {
      identifiers: [uid],
      name: name || `Homeduino ${protocol} ${uid.split('_').slice(-2).join(':')}`,
      model: protocol,
      manufacturer: "Homeduino Bridge",
      sw_version: "3.4.1"
    };

    if (type === 'switch' || values.state !== undefined) {
      const payload = {
        name: "Switch",
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
        ['temperature', 'humidity', 'hum', 'battery', 'lowbattery', 'contact'].includes(k)
      );
      
      if (['weather', 'mandolyn', 'oregon', 'cresta', 'weather2', 'tfa'].some(p => protocol.includes(p))) {
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
          device_class: haKey === 'temperature' ? 'temperature' : (haKey === 'humidity' ? 'humidity' : (haKey === 'battery' ? 'battery' : (haKey === 'contact' ? 'door' : null))),
          availability_topic: "homeduino/status",
          device: commonDevice
        };
        mqttClient.publish(`homeassistant/sensor/homeduino/${uid}_${haKey}/config`, JSON.stringify(payload), { retain: true });
      });
    }
    socket.emit('toast', 'Hierarchical Discovery Sent');
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  const { uid, basePath } = getHierarchy(event.protocol, event.values, event.raw);
  const v = { ...event.values };

  if (options.debug) console.log(`[RF Receive] Protocol: ${event.protocol} | UID: ${uid} | Data: ${JSON.stringify(v)}`);

  Object.keys(v).forEach(key => {
    let value = v[key];
    let topicKey = key;

    if (key === 'state') value = (value === true || value === 1 || value === 'on') ? 'on' : 'off';
    if (key === 'hum') topicKey = 'humidity';

    if (['temperature', 'humidity', 'battery', 'state', 'lowbattery', 'contact'].includes(topicKey)) {
      mqttClient.publish(`homeduino/${basePath}/${topicKey}`, value.toString(), { retain: true });
    }
  });

  io.emit('signal', { 
    timestamp: new Date().toISOString(), 
    protocol: event.protocol, 
    values: event.values, 
    uid: uid,
    raw: event.raw
  });
});

server.listen(8080);
homeduino.connect();
