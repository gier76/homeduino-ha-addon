const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const page = context.pages().find(p => p.url().includes('8123'));
    if (!page) {
        console.error('Home Assistant page not found');
        return;
    }
    const iframe = page.frame({ title: 'Advanced SSH & Web Terminal' });
    if (!iframe) {
        console.error('Terminal iframe not found');
        return;
    }
    const input = await iframe.getByRole('textbox', { name: 'Terminal input' });
    await input.focus();

    const files = [
        {
          path: '/addons/homeduino_bridge/config.yaml',
          content: 'name: "Homeduino Bridge"\n' +
                   'version: "3.8.1"\n' +
                   'slug: "homeduino_bridge"\n' +
                   'description: "Bridge between Homeduino (433MHz) and Home Assistant - Modernized with Ingress and Hardware handling"\n' +
                   'url: "https://github.com/gier76/homeduino-ha-addon"\n' +
                   'arch:\n' +
                   '  - amd64\n' +
                   'startup: services\n' +
                   'boot: auto\n' +
                   'ingress: true\n' +
                   'ingress_port: 8080\n' +
                   'panel_icon: mdi:radio-tower\n' +
                   'mqtt: true\n' +
                   'options:\n' +
                   '  serial_port: "/dev/ttyUSB0"\n' +
                   '  baud_rate: 115200\n' +
                   '  mqtt_broker: "core-mosquitto"\n' +
                   '  mqtt_port: 1883\n' +
                   '  mqtt_user: ""\n' +
                   '  mqtt_password: ""\n' +
                   '  debug: false\n' +
                   'schema:\n' +
                   '  serial_port: str\n' +
                   '  baud_rate: int?\n' +
                   '  mqtt_broker: str\n' +
                   '  mqtt_port: int?\n' +
                   '  mqtt_user: str?\n' +
                   '  mqtt_password: password?\n' +
                   '  debug: bool\n' +
                   'devices:\n' +
                   '  - /dev/ttyUSB0\n' +
                   '  - /dev/ttyUSB1\n' +
                   '  - /dev/ttyS0\n' +
                   '  - /dev/ttyACM0\n' +
                   '  - /dev/ttyACM1\n'
        },
        {
          path: '/addons/homeduino_bridge/Dockerfile',
          content: 'FROM node:20-alpine\n' +
                   'WORKDIR /app\n' +
                   'RUN apk add --no-cache python3 make g++ udev git linux-headers\n' +
                   'COPY package.json .\n' +
                   'RUN npm install --production --unsafe-perm\n' +
                   'COPY . .\n' +
                   'RUN chmod a+x run.sh\n' +
                   'EXPOSE 8080\n' +
                   'CMD [ "./run.sh" ]\n'
        },
        {
          path: '/addons/homeduino_bridge/package.json',
          content: '{\n' +
                   '  "name": "homeduino-ha-addon",\n' +
                   '  "version": "3.8.1",\n' +
                   '  "description": "Bridge between Homeduino (433MHz) and Home Assistant with modern dependencies",\n' +
                   '  "main": "index.js",\n' +
                   '  "scripts": {\n' +
                   '    "start": "node index.js"\n' +
                   '  },\n' +
                   '  "dependencies": {\n' +
                   '    "serialport": "^12.0.0",\n' +
                   '    "rfcontroljs": "^0.0.10",\n' +
                   '    "mqtt": "^5.0.0",\n' +
                   '    "express": "^4.18.2",\n' +
                   '    "socket.io": "^4.6.1"\n' +
                   '  }\n' +
                   '}\n'
        },
        {
          path: '/addons/homeduino_bridge/run.sh',
          content: '#!/bin/sh\n' +
                   'echo "Starting Homeduino Bridge (Modernized)..."\n' +
                   'node index.js\n'
        },
        {
          path: '/addons/homeduino_bridge/index.js',
          content: require('fs').readFileSync('homeduino_bridge/index.js', 'utf8')
        },
        {
          path: '/addons/homeduino_bridge/public/index.html',
          content: require('fs').readFileSync('homeduino_bridge/public/index.html', 'utf8')
        }
    ];

    for (const file of files) {
      console.log(`Writing ${file.path}...`);
      const cmd = `cat > ${file.path} <<'EOF'\n${file.content}EOF\n`;
      // Typing character by character is slow, so we use type() with large strings
      // But avoid shell character escaping issues by typing content directly to the terminal input
      await page.keyboard.type(cmd);
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log('All files written successfully');
  } catch (err) {
    console.error(err);
  }
})();
