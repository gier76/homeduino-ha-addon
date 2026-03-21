async (page) => {
  const iframe = page.frame({ title: 'Advanced SSH & Web Terminal' });
  const input = await iframe.getByRole('textbox', { name: 'Terminal input' });
  await input.focus();
  const config = 'cat > /addons/homeduino_bridge/config.yaml <<\'EOF\'\n' +
    'name: "Homeduino Bridge"\n' +
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
    '  - /dev/ttyACM1\n' +
    'EOF\n';
  for (const char of config) {
    await page.keyboard.type(char);
  }
  await page.keyboard.press('Enter');
}
