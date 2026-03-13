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
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (e) {
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

// 3. Initialize Homeduino
const homeduino = new Homeduino(SERIAL_PORT);

// 4. Initialize MQTT
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

// 5. Web UI (Ingress)
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

io.on('connection', (socket) => {
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
