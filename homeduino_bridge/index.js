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
      // Start receiving on pin 0
      this.write('RF receive 0'); 
    });

    this.serial.on('error', (err) => {
      console.error('Serial Error:', err);
      this.emit('error', err);
    });

    this.parser.on('data', (line) => {
      this.handleLine(line);
    });
  }

  handleLine(line) {
    line = line.trim();
    if (line === 'ready') {
      console.log('Homeduino Arduino is ready.');
      return;
    }

    if (line.startsWith('RF receive ')) {
      // Homeduino sends "RF receive [pulse1] [pulse2] ... [pulse10]"
      // We need to join them and pass to prepareCompressedPulses
      const parts = line.split(' ');
      const strSeq = parts.slice(2).join(' ');
      try {
        const info = rfcontrol.prepareCompressedPulses(strSeq);
        this.decode(info.pulseLengths, info.pulses);
      } catch (e) {
        if (process.env.DEBUG) console.error('Decoding Error:', e.message);
      }
    } else if (line.startsWith('PULSES ')) {
      // Some versions send PULSES directly
      // We might need to bucket them manually or use another rfcontrol method
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
        // Format for Homeduino: RF send [pin] [repeats] [p1] [p2] [p3] [p4] [p5] [p6] [p7] [p8] [bitstring]
        // We use pin 4 for sending as default, repeats 4
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
  if (err.stack) console.debug(err.stack);
});

mqttClient.on('message', (topic, message) => {
  if (topic.startsWith('homeduino/command/')) {
    const protocol = topic.split('/').pop();
    try {
      const values = JSON.parse(message.toString());
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
  console.log('Web UI connected');
  socket.emit('status', { connected: homeduino.connected, error: lastError });
  socket.emit('mqtt_status', { connected: mqttClient.connected });

  socket.on('send_command', (data) => {
    homeduino.send(data.protocol, data.values).catch(err => socket.emit('error', err.message));
  });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name } = data;
    const id = values.id || 0;
    const unit = values.unit || 0;
    const uniqueId = `homeduino_${protocol}_${id}_${unit}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    const payload = {
      name: name || `Homeduino ${protocol} ${id}:${unit}`,
      unique_id: uniqueId,
      command_topic: `homeduino/command/${protocol}`,
      payload_on: JSON.stringify({ ...values, state: 'on' }),
      payload_off: JSON.stringify({ ...values, state: 'off' }),
      state_topic: `homeduino/received/${protocol}`,
      value_template: `{% if value_json.id == ${id} and value_json.unit == ${unit} %}{{ value_json.state }}{% else %}{{ states('switch.${uniqueId}') }}{% endif %}`,
      device: { identifiers: [uniqueId], name: name || `Homeduino Device ${id}`, model: protocol, manufacturer: "Homeduino Bridge" }
    };

    mqttClient.publish(`homeassistant/switch/${uniqueId}/config`, JSON.stringify(payload), { retain: true });
    socket.emit('toast', `Device added: ${name}`);
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  mqttClient.publish(`homeduino/received/${event.protocol}`, JSON.stringify(event.values));
  io.emit('signal', { timestamp: new Date().toISOString(), protocol: event.protocol, values: event.values });
});

const PORT = 8080;
server.listen(PORT, () => console.log(`Web UI listening on port ${PORT}`));

homeduino.connect();
