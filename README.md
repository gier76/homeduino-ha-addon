# 📡 Homeduino Home Assistant Add-on

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-Add--on-blue.svg)](https://www.home-assistant.io/)
[![Version](https://img.shields.io/badge/Version-3.2.2-green.svg)](#)

A modernized bridge between your **Homeduino (Arduino 433MHz Transceiver)** and **Home Assistant**. Control your legacy 433MHz devices with ease using MQTT and a sleek Web UI.

---

## 🚀 Features

- **Ingress Support:** Integrated directly into the Home Assistant sidebar.
- **Modern Web UI:** Real-time signal scanner and device manager.
- **One-Click Discovery:** Identify 433MHz protocols and add them to Home Assistant instantly.
- **MQTT Bridge:** Reliable communication with Mosquitto Broker.
- **Protocol Support:** Powered by `rfcontroljs` for a wide range of 433MHz devices.
- **Robust Debugging:** Detailed serial and MQTT logging to track every pulse.

---

## 🛠 Installation

1. Add this repository to your Home Assistant Add-on Store:
   `https://github.com/gier76/homeduino-ha-addon`
2. Install the **Homeduino Bridge** add-on.
3. Ensure you have an **MQTT Broker** (like Mosquitto) installed and running.
4. Configure your serial port (default: `/dev/ttyUSB0`).
5. Start the add-on and open the Web UI!

---

## 📋 Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `serial_port` | Path to your Arduino transceiver | `/dev/ttyUSB0` |
| `mqtt_broker` | Hostname of your MQTT broker | `core-mosquitto` |
| `mqtt_user` | MQTT username (optional) | |
| `mqtt_password` | MQTT password (optional) | |
| `debug` | Enable verbose serial logging | `false` |

---

## 🔌 Hardware requirements

- **Arduino** (Nano/Uno) with Homeduino Sketch.
- **433MHz Receiver & Transmitter** modules.
- Connected via USB to your Home Assistant host.

---

## 📡 MQTT Topics

- **Status:** `homeduino/status` (`online` / `offline`)
- **Received:** `homeduino/received/[protocol]`
- **Commands:** `homeduino/command/[protocol]`

---

## ❤️ Contributing

Feel free to open issues or pull requests. Let's make 433MHz great again!

---

*Developed with precision for the Home Assistant Community.*
