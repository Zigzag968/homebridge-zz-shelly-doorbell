import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  CharacteristicValue,
  HAP
} from 'homebridge';
import * as http from 'http';
import { URL } from 'url';
import { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_PORT } from './settings';

/**
 * Point d'entrée du plugin.
 */
module.exports = (homebridge: API) => {
  homebridge.registerPlatform(PLATFORM_NAME, ShellyDoorbellPlatform);
};

//
// Plateforme dynamique qui gère les dispositifs Shelly
//
class ShellyDoorbellPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  // Map permettant d’accéder rapidement aux accessoires par leur host
  public readonly accessoryMap: Map<string, ShellyDoorbellAccessory> = new Map();
  private server: http.Server;
  private port: number;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('ShellyDoorbellPlatform : Initialisation de la plateforme...');
    // Le port d’écoute du serveur web (pour les callbacks) est défini dans la config ou par défaut
    this.port = this.config.port || DEFAULT_PORT;
    // Création du serveur HTTP pour recevoir les webhooks de Shelly
    this.server = http.createServer(this.requestListener.bind(this));
    this.server.listen(this.port, () => {
      this.log.info(`Le serveur webhook Shelly écoute sur le port ${this.port}`);
    });

    this.api.on('didFinishLaunching', () => {
      this.log.debug('ShellyDoorbellPlatform : didFinishLaunching');
      this.discoverDevices();
    });
  }

  /**
   * Méthode appelée par Homebridge pour restaurer un accessoire depuis le cache.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restauration d’un accessoire depuis le cache :', accessory.displayName);
    this.accessories.push(accessory);
    const deviceConfig = accessory.context.device;
    if (deviceConfig && deviceConfig.host) {
      const shellyAccessory = new ShellyDoorbellAccessory(this, accessory, deviceConfig);
      this.accessoryMap.set(deviceConfig.host, shellyAccessory);
    }
  }

  /**
   * Découverte des dispositifs définis dans la configuration.
   * La config peut être soit un objet unique, soit contenir un tableau "devices".
   */
  discoverDevices(): void {
    const devices = (this.config.devices && Array.isArray(this.config.devices))
      ? this.config.devices
      : [this.config];
    for (const deviceConfig of devices) {
      if (!deviceConfig.host) {
        this.log.error('La configuration d’un dispositif doit inclure la propriété "host".');
        continue;
      }
      const uuid = this.api.hap.uuid.generate(deviceConfig.host);
      let accessory = this.accessories.find(acc => acc.UUID === uuid);
      if (accessory) {
        this.log.info('Restauration de l’accessoire existant :', accessory.displayName);
        accessory.context.device = deviceConfig;
        const shellyAccessory = new ShellyDoorbellAccessory(this, accessory, deviceConfig);
        this.accessoryMap.set(deviceConfig.host, shellyAccessory);
      } else {
        this.log.info('Ajout d’un nouvel accessoire :', deviceConfig.name || deviceConfig.host);
        accessory = new this.api.platformAccessory(deviceConfig.name || 'Shelly Doorbell', uuid);
        accessory.context.device = deviceConfig;
        const shellyAccessory = new ShellyDoorbellAccessory(this, accessory, deviceConfig);
        this.accessories.push(accessory);
        this.accessoryMap.set(deviceConfig.host, shellyAccessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Listener des requêtes HTTP entrantes (webhooks).
   * On attend des requêtes sur le chemin "/shelly" avec des paramètres query.
   */
  private requestListener(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!req.url) {
      res.statusCode = 400;
      res.end('Aucune URL fournie');
      return;
    }
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    if (parsedUrl.pathname !== '/shelly') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    // Paramètres attendus : host, event, et éventuellement state pour openDoor
    const hostParam = parsedUrl.searchParams.get('host');
    const eventParam = parsedUrl.searchParams.get('event');
    const stateParam = parsedUrl.searchParams.get('state');
    if (!hostParam || !eventParam) {
      res.statusCode = 400;
      res.end('Paramètres "host" ou "event" manquants');
      return;
    }
    this.log.debug(`Webhook reçu : host=${hostParam}, event=${eventParam}, state=${stateParam}`);

    const shellyAccessory = this.accessoryMap.get(hostParam);
    if (!shellyAccessory) {
      res.statusCode = 404;
      res.end('Accessoire introuvable');
      return;
    }

    if (eventParam === 'doorbell') {
      shellyAccessory.triggerDoorbell();
      res.statusCode = 200;
      res.end('Événement doorbell traité');
    } else if (eventParam === 'openDoor') {
      if (stateParam === 'on') {
        shellyAccessory.updateOpenDoorState(true);
      } else if (stateParam === 'off') {
        shellyAccessory.updateOpenDoorState(false);
      } else {
        res.statusCode = 400;
        res.end('Paramètre "state" invalide pour openDoor');
        return;
      }
      res.statusCode = 200;
      res.end(`État openDoor mis à jour vers ${stateParam}`);
    } else {
      res.statusCode = 400;
      res.end('Type d’événement inconnu');
    }
  }
}

//
// Classe représentant un accessoire Shelly Doorbell
//
class ShellyDoorbellAccessory {
  private readonly informationService: Service;
  private readonly doorbellService: Service;     // Service Stateless Programmable Switch
  private readonly testButtonService: Service;     // Bouton de test pour la sonnette
  private readonly openDoorService: Service;       // Bouton pour ouvrir la porte
  // On maintient en interne l’état du bouton "Ouvrir la Porte"
  private currentOpenDoorState: boolean = false;

  constructor(
    private readonly platform: ShellyDoorbellPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: any,
  ) {
    const { Service, Characteristic } = this.platform.api.hap;

    // Informations sur l’accessoire
    this.informationService =
      accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
      .setCharacteristic(Characteristic.Model, 'Shelly 1 Gen 3')
      .setCharacteristic(Characteristic.SerialNumber, config.host);

    // Service de sonnette (Stateless Programmable Switch)
    this.doorbellService =
      accessory.getService('Doorbell') || accessory.addService(Service.StatelessProgrammableSwitch, 'Doorbell', 'doorbell');

    // Bouton de test pour simuler la sonnette
    this.testButtonService =
      accessory.getService('Test Doorbell') || accessory.addService(Service.Switch, 'Test Doorbell', 'testDoorbell');
    this.testButtonService.getCharacteristic(Characteristic.On)
      .onSet((value: CharacteristicValue) => this.handleTestButton(value as boolean))
      .onGet(() => false);

    // Bouton pour ouvrir la porte
    this.openDoorService =
      accessory.getService('Ouvrir la Porte') || accessory.addService(Service.Switch, 'Ouvrir la Porte', 'openDoor');
    this.openDoorService.getCharacteristic(Characteristic.On)
      .onSet(this.handleOpenDoor.bind(this))
      .onGet(() => this.currentOpenDoorState);
  }

  /**
   * Déclenche l’événement de sonnette (doorbell) dans HomeKit.
   * La caractéristique ProgrammableSwitchEvent est mise à 0 (SINGLE PRESS).
   */
  public triggerDoorbell(): void {
    const { Characteristic } = this.platform.api.hap;
    this.platform.log.info(`Déclenchement de la sonnette pour ${this.config.host}`);
    this.doorbellService.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, 0);
  }

  /**
   * Handler pour le bouton Test Doorbell activé depuis HomeKit.
   * Lorsque l’utilisateur active le bouton, on simule un événement de sonnette,
   * puis on remet le bouton à OFF après 1 seconde.
   */
  private async handleTestButton(value: boolean): Promise<void> {
    if (value as boolean) {
      this.platform.log.info(`Test Doorbell activé pour ${this.config.host}`);
      this.triggerDoorbell();
      setTimeout(() => {
        this.testButtonService.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
      }, 1000);
    }
  }

  /**
   * Handler pour le bouton Open Door activé depuis HomeKit.
   * Lorsque l’utilisateur active le bouton, on envoie une commande RPC à Shelly.
   * Shelly, via sa configuration, désactive automatiquement la commande, et le plugin
   * attend un webhook pour mettre à jour l’état du bouton.
   */
  private async handleOpenDoor(value: CharacteristicValue): Promise<void> {
    if (value) {
      this.platform.log.info(`Commande "Ouvrir la Porte" demandée via HomeKit pour ${this.config.host}`);
      const url = `http://${this.config.host}/rpc/Switch.Set?id=0&on=true`;
      this.sendHttpCommand(url, (err) => {
        if (err) {
          this.platform.log.error(`Erreur lors de l’envoi de la commande openDoor à ${this.config.host} : ${err.message}`);
          // En cas d’erreur, on remet le bouton à OFF
          this.updateOpenDoorState(false);
        } else {
          this.platform.log.info(`Commande openDoor envoyée à ${this.config.host}`);
          // On met à jour l’état en ON (l’actualisation finale se fera via le webhook de Shelly)
          this.updateOpenDoorState(true);
        }
      });
    }
  }

  /**
   * Met à jour l’état du bouton "Ouvrir la Porte" dans HomeKit.
   * Cet état est mis à jour soit suite à une commande envoyée, soit via un webhook reçu de Shelly.
   */
  public updateOpenDoorState(newState: boolean): void {
    if (this.currentOpenDoorState !== newState) {
      this.currentOpenDoorState = newState;
      this.platform.log.info(`Mise à jour de l’état "Ouvrir la Porte" pour ${this.config.host} : ${newState ? 'ON' : 'OFF'}`);
      this.openDoorService.updateCharacteristic(this.platform.api.hap.Characteristic.On, newState);
    }
  }

  /**
   * Envoie une commande HTTP GET à l’URL spécifiée.
   */
  private sendHttpCommand(url: string, callback: (err?: Error) => void): void {
    this.platform.log.debug(`Envoi d’une commande HTTP : ${url}`);
    http.get(url, (res) => {
      // La réponse n’est pas traitée en détail ici
      res.on('data', () => {});
      res.on('end', () => callback());
    }).on('error', (err) => {
      callback(err);
    });
  }
}