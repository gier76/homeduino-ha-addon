const mqtt = require('./homeduino_bridge/node_modules/mqtt');
const client = mqtt.connect('mqtt://192.168.19.128:1883');

const device_id = 'hd_switch2_31_4';
const protocol = 'switch2';

const device = {
    identifiers: [device_id],
    name: `Homeduino Switch 31 4`,
    model: protocol,
    manufacturer: 'Homeduino Bridge',
    sw_version: "5.1.1"
};

const payload = {
    name: "Switch",
    unique_id: `${device_id}_switch`,
    state_topic: `homeduino/${protocol}/${device_id}/state`,
    command_topic: `homeduino/${protocol}/${device_id}/set`,
    payload_on: "true",
    payload_off: "false",
    device: device
};

client.on('connect', () => {
    console.log('Connected to MQTT');
    client.publish(`homeassistant/switch/${device_id}/config`, JSON.stringify(payload), { retain: true }, (err) => {
        if (err) console.error('Error:', err);
        else console.log('Discovery message sent for', device_id);
        client.end();
    });
});
