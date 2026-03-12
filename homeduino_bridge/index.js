const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Homeduino } = require('homeduino');

// 1. Read configuration (Hass.io standard)
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

// 2. Initialize Homeduino
console.log(`Connecting to Homeduino on ${SERIAL_PORT}...`);
const homeduino = new Homeduino('serialport', {
  serialDevice: SERIAL_PORT,
  baudrate: 115200
});

homeduino.on('connected', () => {
  console.log('Homeduino connected!');
});

homeduino.on('error', (err) => {
  console.error('Homeduino Error:', err);
});

// 3. Initialize MQTT
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
  // Handle commands sent from HA to Homeduino
  // Format: homeduino/command/[protocol] - payload: JSON values
  if (topic.startsWith('homeduino/command/')) {
    const protocol = topic.split('/').pop();
    try {
      const values = JSON.parse(message.toString());
      console.log(`Sending command: protocol=${protocol}, values=`, values);
      homeduino.send(protocol, values).catch(err => {
        console.error('Send Error:', err);
      });
    } catch (e) {
      console.error('Failed to parse MQTT message:', e);
    }
  }
});

// 4. Web UI for Scanning (Ingress)
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

io.on('connection', (socket) => {
  console.log('Web UI connected');

  // Handle "Send Command" from UI (Test button)
  socket.on('send_command', (data) => {
    // data: { protocol, values }
    console.log('UI Request: Send Command', data);
    homeduino.send(data.protocol, data.values).catch(err => {
      console.error('Send Error:', err);
      socket.emit('error', err.message);
    });
  });

  // Handle "Add to HA" from UI
  socket.on('add_device', (data) => {
    // data: { protocol, values, type (switch/sensor), name }
    console.log('UI Request: Add Device', data);
    
    const { protocol, values, type, name } = data;
    const id = values.id || 0;
    const unit = values.unit || 0;
    // Create a unique ID safely
    const uniqueId = `homeduino_${protocol}_${id}_${unit}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    let configTopic = '';
    let payload = {};

    if (type === 'switch') {
      configTopic = `homeassistant/switch/${uniqueId}/config`;
      
      // Construct the payload required to turn this specific device ON/OFF
      // The bridge listens on homeduino/command/[protocol]
      const cmdPayloadOn = { ...values, state: 'on' };
      const cmdPayloadOff = { ...values, state: 'off' };

      payload = {
        name: name || `Homeduino ${protocol} ${id}:${unit}`,
        unique_id: uniqueId,
        command_topic: `homeduino/command/${protocol}`,
        payload_on: JSON.stringify(cmdPayloadOn),
        payload_off: JSON.stringify(cmdPayloadOff),
        state_topic: `homeduino/received/${protocol}`,
        // Template to extract state if the device reports back, 
        // matching the id/unit to ensure we only update OUR state
        value_template: `{% if value_json.id == ${id} and value_json.unit == ${unit} %}{{ value_json.state }}{% else %}{{ states('switch.${uniqueId}') }}{% endif %}`,
        device: {
          identifiers: [uniqueId],
          name: name || `Homeduino Device ${id}`,
          model: protocol,
          manufacturer: "Homeduino Bridge"
        }
      };
    } 
    // Add other types (sensor) here as needed
    
    if (configTopic && payload) {
      console.log(`Publishing Discovery to ${configTopic}`);
      mqttClient.publish(configTopic, JSON.stringify(payload), { retain: true });
      socket.emit('toast', `Device added: ${name}`);
    }
  });
});

// 5. Signal handling (The "Pimatic" Scanning experience)
homeduino.on('rfControlReceive', (event) => {
  // event contains: protocol, values
  if (DEBUG) {
    console.log(`Received: [${event.protocol}]`, event.values);
  }

  // Publish to MQTT (for HA automation/devices)
  const mqttTopic = `homeduino/received/${event.protocol}`;
  mqttClient.publish(mqttTopic, JSON.stringify(event.values));

  // Push to Web UI (for Scanning)
  io.emit('signal', {
    timestamp: new Date().toISOString(),
    protocol: event.protocol,
    values: event.values
  });
});

// Also handle raw signals for advanced scanning
homeduino.on('rfControlRaw', (event) => {
  // This is what pimatic shows in logs when it can't decode or for debugging
  io.emit('raw', {
    timestamp: new Date().toISOString(),
    pulses: event.pulses,
    buckets: event.buckets
  });
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Web UI (Scanning) listening on port ${PORT}`);
});

homeduino.connect();
