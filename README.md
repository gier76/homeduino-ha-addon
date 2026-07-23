# Homeduino Bridge v5.1.5
[Screenshot](https://github.com/gier76/homeduino-ha-addon/blob/main/Screenshot%202026-07-23%20191412.png)
Modernized Home Assistant Add-on that bridges 433MHz RF sensors and switches to Home Assistant using an Arduino (Homeduino) and MQTT Discovery.

## 🚀 Features

- **Cyberpunk Dark UI**: High-tech real-time signal analyzer with glow effects.
- **Live Status Badges**: Real-time status indicators in the GUI for USB Hardware (`/dev/ttyUSB0`) and MQTT Broker connection.
- **Bi-Directional Switch Control**: Full sending and receiving support for 433MHz switches (`switch1`, `switch2`, `switch3`, `switch4`) with 5-burst signal repetition for maximum reliability.
- **Selective Discovery**: Add discovered sensors and switches to Home Assistant with a single click ("In HA hinzufügen").
- **Extended Weather Protocol**: Full temperature and humidity decoding for `weather2` (bits 28-35) and `weather1`/`weather3`.
- **Robust UID Generation**: Guarantees unique device IDs in Home Assistant using protocol parameters (`id`, `houseCode`, `unitCode`, `unit`, `channel`, `systemcode`) with MD5 fallback.
- **Ingress Support**: Native integration into the Home Assistant sidebar.

## 🛠 Hardware Setup

To use this add-on, you need a **Homeduino** compatible hardware setup:

1. **Arduino Nano/Uno**: Connected via USB to your Home Assistant host.
2. **433MHz Receiver**: (e.g., RXB6 or similar high-quality module) connected to the Arduino interrupt pin.
3. **433MHz Transmitter**: (Optional, for switches) connected to the Arduino output pin.
4. **Homeduino Sketch**: The Arduino must be running the [Homeduino Sketch](https://github.com/pimatic/homeduino).

### Typical Pinout:
- Receiver Data -> Arduino Pin D2 (Interrupt)
- Transmitter Data -> Arduino Pin D4

## 🖥 User Interface

The modern Web UI allows you to monitor incoming 433MHz signals, inspect status, and add devices to Home Assistant.

### Features in the GUI:
- **USB & MQTT Connection Indicators**: Live green/red LEDs for system state.
- **Selective Discovery**: Click **"In HA hinzufügen"** on any detected signal card. The add-on immediately sends MQTT discovery payloads to Home Assistant, creating entities automatically.

## 📦 Installation

1. Add this repository URL (`https://github.com/gier76/homeduino-ha-addon`) to your Home Assistant Add-on Store.
2. Install **"Homeduino Bridge"**.
3. Configure your `serial_port` (e.g., `/dev/ttyUSB0`) and MQTT settings.
4. Start the add-on.

## ⚙️ Configuration

Example configuration:
```json
{
  "serial_port": "/dev/ttyUSB0",
  "baud_rate": 115200,
  "mqtt_broker": "core-mosquitto",
  "mqtt_port": 1883,
  "mqtt_user": "",
  "mqtt_password": "",
  "debug": false
}
```

## 📝 Troubleshooting

- **No signals detected?** Check your `serial_port` and ensure the Arduino is running the Homeduino firmware.
- **MQTT issue?** Ensure Mosquitto broker add-on is installed and running in Home Assistant.
- **Debug mode**: Enable `debug: true` in options to inspect raw signal pulse sequences in the log output.

---
*Maintained by gier76*

