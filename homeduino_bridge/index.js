const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const rfcontrol = require('rfcontroljs');
const EventEmitter = require('events');

// 1. Homeduino Bridge Class (Modern implementation)
class Homeduino extends EventEmitter {
  constructor(port, baudRate = 115200) {
    super();
    this.portPath = port;
    this.baudRate = baudRate;
    this.serial = null;
    this.parser = null;
    this.controller = new rfcontrol();
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
      // Start receiving on pin 0 (standard homeduino pin)
      // Note: In original homeduino pin 4 was often used for receiver.
      // We'll try to find the pin from options or use 0 as default.
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
    if (line.trim() === 'ready') {
      console.log('Homeduino Arduino is ready.');
      return;
    }

    if (line.startsWith('PULSES ')) {
      const parts = line.substring(7).trim().split(' ');
      const pulses = parts.map(p => parseInt(p, 10));
      this.decode(pulses);
    } else {
      if (process.env.DEBUG) console.log('Arduino Log:', line);
    }
  }

  decode(pulses) {
    const results = this.controller.decode(pulses);
    if (results && results.length > 0) {
      for (const result of results) {
        this.emit('rfControlReceive', {
          protocol: result.protocol,
          values: result.values
        });
      }
    } else {
      // Optional: emit raw for UI scanning
      this.emit('rfControlRaw', {
        timestamp: new Date().toISOString(),
        pulses: pulses
      });
    }
  }

  async send(protocol, values) {
    console.log(`Encoding command: ${protocol}`, values);
    const pulses = this.controller.encode(protocol, values);
    if (pulses) {
      // Format: RF send [pulse_count] [p1] [p2] ...
      const command = `RF send ${pulses.length} ${pulses.join(' ')}`;
      return this.write(command);
    } else {
      throw new Error(`Failed to encode protocol ${protocol}`);
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

// 2. Read configuration (Hass.io standard)
let options = {};
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (e) {
  console.log('Using default options (not running as HA addon)');
  options = {
    serial_port: process.env.SERIAL_PORT || '/dev/ttyUSB0',
    mqtt_broker: process.env.MQTT_BROKER || 'localhost',
    mqtt_user: process.env.MQTT_USER || '',
    mqtt_password: process.env.MQTT_PASSWORD || '',
    debug: true
  };
}

const SERIAL_PORT = options.serial_port;
const MQTT_URL = `mqtt://${options.mqtt_broker}`;
const DEBUG = options.debug;
if (DEBUG) process.env.DEBUG = 'true';

// 3. Initialize Homeduino
const homeduino = new Homeduino(SERIAL_PORT);

homeduino.on('connected', () => {
  console.log('Homeduino connected!');
});

// 4. Initialize MQTT
console.log(`Connecting to MQTT at ${MQTT_URL}...`);
const mqttClient = mqtt.connect(MQTT_URL, {
  username: options.mqtt_user,
  password: options.mqtt_password
});

mqttClient.on('connect', () => {
  console.log('MQTT connected!');
  mqttClient.subscribe('homeduino/command/#');
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

// 5. Web UI for Scanning (Ingress)
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

io.on('connection', (socket) => {
  console.log('Web UI connected');

  socket.on('send_command', (data) => {
    homeduino.send(data.protocol, data.values).catch(err => {
      socket.emit('error', err.message);
    });
  });

  socket.on('add_device', (data) => {
    const { protocol, values, type, name } = data;
    const id = values.id || 0;
    const unit = values.unit || 0;
    const uniqueId = `homeduino_${protocol}_${id}_${unit}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    let configTopic = '';
    let payload = {};

    if (type === 'switch') {
      configTopic = `homeassistant/switch/${uniqueId}/config`;
      const cmdPayloadOn = { ...values, state: 'on' };
      const cmdPayloadOff = { ...values, state: 'off' };

      payload = {
        name: name || `Homeduino ${protocol} ${id}:${unit}`,
        unique_id: uniqueId,
        command_topic: `homeduino/command/${protocol}`,
        payload_on: JSON.stringify(cmdPayloadOn),
        payload_off: JSON.stringify(cmdPayloadOff),
        state_topic: `homeduino/received/${protocol}`,
        value_template: `{% if value_json.id == ${id} and value_json.unit == ${unit} %}{{ value_json.state }}{% else %}{{ states('switch.${uniqueId}') }}{% endif %}`,
        device: {
          identifiers: [uniqueId],
          name: name || `Homeduino Device ${id}`,
          model: protocol,
          manufacturer: "Homeduino Bridge"
        }
      };
    } 
    
    if (configTopic && payload) {
      mqttClient.publish(configTopic, JSON.stringify(payload), { retain: true });
      socket.emit('toast', `Device added: ${name}`);
    }
  });
});

// 6. Signal handling
homeduino.on('rfControlReceive', (event) => {
  const mqttTopic = `homeduino/received/${event.protocol}`;
  mqttClient.publish(mqttTopic, JSON.stringify(event.values));

  io.emit('signal', {
    timestamp: new Date().toISOString(),
    protocol: event.protocol,
    values: event.values
  });
});

homeduino.on('rfControlRaw', (event) => {
  io.emit('raw', event);
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Web UI listening on port ${PORT}`);
});

homeduino.connect();
