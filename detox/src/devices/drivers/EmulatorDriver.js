const _ = require('lodash');
const path = require('path');
const ini = require('ini');
const fs = require('fs');
const os = require('os');
const Emulator = require('../android/Emulator');
const EmulatorTelnet = require('../android/EmulatorTelnet');
const DetoxRuntimeError = require('../../errors/DetoxRuntimeError');
const environment = require('../../utils/environment');
const retry = require('../../utils/retry');
const AndroidDriver = require('./AndroidDriver');
const DeviceRegistry = require('../DeviceRegistry');

const DetoxEmulatorsPortRange = {
  min: 10000,
  max: 20000
};

class EmulatorDriver extends AndroidDriver {
  constructor(config) {
    super(config);

    this.emulator = new Emulator();
    this.deviceRegistry = new DeviceRegistry({
      getDeviceIdsByType: this._getDeviceIdsByType.bind(this),
      createDevice: this._createDevice.bind(this),
      lockfile: environment.getDeviceLockFilePathAndroid(),
    });
    this.pendingBoots = {};
  }

  async acquireFreeDevice(avdName) {
    await this._validateAvd(avdName);
    await this._fixEmulatorConfigIniSkinNameIfNeeded(avdName);

    const adbName = await this.deviceRegistry.getDevice(avdName);
    await this._bootIfNeeded(avdName, adbName);

    await this.adb.apiLevel(adbName);
    await this.adb.unlockScreen(adbName);

    return adbName;
  }

  async _bootIfNeeded(avdName, adbName) {
    const coldBoot = !!this.pendingBoots[adbName];

    // If it's not already running, start it now.
    if (coldBoot) {
      await this.emulator.boot(avdName, {port: this.pendingBoots[adbName]});
      delete this.pendingBoots[adbName];
    }

    await this._waitForBootToComplete(adbName);
    await this.emitter.emit('bootDevice', { coldBoot, deviceId: adbName });

    return adbName;
  }

  async _validateAvd(avdName) {
    const avds = await this.emulator.listAvds();
    if (!avds) {
      const avdmanagerPath = path.join(environment.getAndroidSDKPath(), 'tools', 'bin', 'avdmanager');

      throw new Error(`Could not find any configured Android Emulator. 
      Try creating a device first, example: ${avdmanagerPath} create avd --force --name Pixel_2_API_26 --abi x86 --package 'system-images;android-26;google_apis_playstore;x86' --device "Pixel 2"
      or go to https://developer.android.com/studio/run/managing-avds.html for details on how to create an Emulator.`);
    }

    if (_.indexOf(avds, avdName) === -1) {
      throw new Error(`Can not boot Android Emulator with the name: '${avdName}',
      make sure you choose one of the available emulators: ${avds.toString()}`);
    }
  }

  async _waitForBootToComplete(deviceId) {
    await retry({ retries: 120, interval: 5000 }, async () => {
      const isBootComplete = await this.adb.isBootComplete(deviceId);

      if (!isBootComplete) {
        throw new DetoxRuntimeError({
          message: `Android device ${deviceId} has not completed its boot yet.`,
        });
      }
    });
  }

  async shutdown(deviceId) {
    await this.emitter.emit('beforeShutdownDevice', { deviceId });
    const port = _.split(deviceId, '-')[1];
    const telnet = new EmulatorTelnet();
    await telnet.connect(port);
    await telnet.kill();
    await this.emitter.emit('shutdownDevice', { deviceId });
  }

  async _fixEmulatorConfigIniSkinNameIfNeeded(avdName) {
    const configFile = `${os.homedir()}/.android/avd/${avdName}.avd/config.ini`;
    const config = ini.parse(fs.readFileSync(configFile, 'utf-8'));

    if (!config['skin.name']) {
      const width = config['hw.lcd.width'];
      const height = config['hw.lcd.height'];

      if (width === undefined || height === undefined) {
        throw new Error(`Emulator with name ${avdName} has a corrupt config.ini file (${configFile}), try fixing it by recreating an emulator.`);
      }

      config['skin.name'] = `${width}x${height}`;
      fs.writeFileSync(configFile, ini.stringify(config));
    }
    return config;
  }

  async _getDeviceIdsByType(name) {
    const device = await this.adb.findDevice((candidate) => {
      return (candidate.name === name && this.deviceRegistry.isBusy(candidate.adbName));
    });

    if (device) {
      return device.adbName;
    }
    return undefined;
  }

  async _createDevice() {
    const {min, max} = DetoxEmulatorsPortRange;
    let port = Math.random() * (max - min) + min;
    port = port & (~0 - 1);

    const adbName = `emulator-${port}`;
    this.pendingBoots[adbName] = port;
    return adbName;
  }
}

module.exports = EmulatorDriver;
