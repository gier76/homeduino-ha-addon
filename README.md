# Homeduino Home Assistant Add-on

Bridge between Homeduino (433MHz) and Home Assistant. This add-on allows you to use your 433MHz devices (switches, sensors, etc.) with Home Assistant via an Arduino running the Homeduino sketch.

## Features

- **Modern Web UI**: A real-time scanner to see incoming 433MHz signals.
- **Easy Discovery**: Add discovered devices to Home Assistant with a single click.
- **MQTT Based**: Communicates with Home Assistant using the standard MQTT discovery protocol.
- **Ingress Support**: Access the scanner UI directly from the Home Assistant sidebar.
- **Hardware Support**: Handles serial connections to various USB/Serial transceivers.

## Installation

1. Add this repository to your Home Assistant Add-on Store.
2. Install the "Homeduino Bridge" add-on.
3. Configure your serial port and MQTT settings (if not using the default `core-mosquitto`).
4. Start the add-on.

## Configuration

Default options:

```yaml
serial_port: "/dev/ttyUSB0"
baud_rate: 115200
mqtt_broker: "core-mosquitto"
mqtt_port: 1883
mqtt_user: ""
mqtt_password: ""
debug: false
```

### Serial Port
Make sure to select the correct serial port where your Arduino is connected. You can find available ports in the add-on log if the default one fails to connect.

### MQTT
If you are using the official Mosquitto broker add-on, the default settings should work. If you use an external broker, provide the necessary credentials and address.

## Usage

1. Open the "Web UI" from the add-on page or the sidebar.
2. Watch for incoming signals from your 433MHz remotes or sensors.
3. Use the "Add to HA" button to create a corresponding device in Home Assistant.
4. For switches, you can test the "ON" and "OFF" commands directly from the UI.

## Credits

This add-on is based on the `rfcontroljs` library and inspired by various Homeduino implementations.
