import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  CharacteristicValue,
  HAP,
} from 'homebridge';
import * as http from 'http';
import { URL } from 'url';
import { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_PORT } from './settings';

let hap: HAP;

/**
 * Point d'entrée du plugin.
 */
module.exports = (homebridge: API) => {
  hap = homebridge.hap;
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
    // Forcer la catégorie en INTERCOM pour que l'accessoire soit reconnu comme un interphone
    accessory.category = hap.Accessory.Categories.INTERCOM;
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
        // Forcer la catégorie en INTERCOM
        accessory.category = hap.Accessory.Categories.INTERCOM;
        const shellyAccessory = new ShellyDoorbellAccessory(this, accessory, deviceConfig);
        this.accessoryMap.set(deviceConfig.host, shellyAccessory);
      } else {
        this.log.info('Ajout d’un nouvel accessoire :', deviceConfig.name || deviceConfig.host);
        accessory = new this.api.platformAccessory(deviceConfig.name || 'Shelly Intercom', uuid);
        // Forcer la catégorie en INTERCOM
        accessory.category = hap.Accessory.Categories.INTERCOM;
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
// Classe représentant un accessoire Shelly Intercom
//
class ShellyDoorbellAccessory {
  private readonly informationService: Service;
  private readonly intercomService: Service;     // Service utilisé pour l'intercom
  private readonly testButtonService: Service;     // Bouton de test pour l'intercom
  private readonly openDoorService: Service;       // Serrure pour ouvrir la porte
  // État interne de la serrure
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

    // Service intercom (on utilise le service Doorbell renommé en "Intercom")
    this.intercomService = accessory.getService(Service.Doorbell) ||
      accessory.addService(Service.Doorbell, "Intercom", "intercomService");

    // Bouton de test pour simuler l'intercom
    this.testButtonService =
      accessory.getService('Test Intercom') || accessory.addService(Service.Switch, 'Test Intercom', 'intercomTest');
    this.testButtonService.getCharacteristic(Characteristic.On)
      .onSet((value: CharacteristicValue) => this.handleTestButton(value as boolean))
      .onGet(() => false);

    // Serrure pour ouvrir la porte
    this.openDoorService = accessory.getService(Service.LockMechanism) ||
      accessory.addService(Service.LockMechanism, "Serrure de Porte", "openDoor");
    this.openDoorService.getCharacteristic(Characteristic.LockTargetState)
      .onSet(this.handleLockTargetState.bind(this))
      .onGet(this.getLockCurrentState.bind(this));
  }

  /**
   * Déclenche l’événement intercom dans HomeKit.
   * La caractéristique ProgrammableSwitchEvent est mise à SINGLE_PRESS.
   */
  public triggerIntercom(): void {
    const { Characteristic } = this.platform.api.hap;
    this.platform.log.info(`Déclenchement de l'intercom pour ${this.config.host}`);
    this.intercomService.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  }

  /**
   * Handler pour le bouton Test Intercom activé depuis HomeKit.
   * Lorsque l’utilisateur active le bouton, on simule un événement intercom,
   * puis on remet le bouton à OFF après 1 seconde.
   */
  private async handleTestButton(value: boolean): Promise<void> {
    if (value) {
      this.platform.log.info(`Test Intercom activé pour ${this.config.host}`);
      this.triggerIntercom();
      setTimeout(() => {
        this.testButtonService.updateCharacteristic(this.platform.api.hap.hap.Characteristic.On, false);
      }, 1000);
    }
  }

  /**
   * HomeKit demande à changer l'état de la serrure (ouvrir/fermer).
   */
  private async handleLockTargetState(value: number): Promise<void> {
    if (value === hap.Characteristic.LockTargetState.UNSECURED) {
      this.platform.log.info(`Commande de déverrouillage envoyée pour ${this.config.host}`);
      const url = `http://${this.config.host}/rpc/Switch.Set?id=0&on=true`;
      this.sendHttpCommand(url, (err) => {
        if (err) {
          this.platform.log.error(`Erreur lors de la commande d'ouverture : ${err.message}`);
        } else {
          this.platform.log.info(`Porte déverrouillée`);
          this.updateLockState(true);
        }
      });
    } else {
      this.platform.log.info(`Commande de verrouillage reçue, mais action non supportée`);
    }
  }

  /**
   * Renvoie l'état actuel de la serrure (verrouillé/déverrouillé).
   */
  private getLockCurrentState(): number {
    return this.currentOpenDoorState
      ? hap.Characteristic.LockCurrentState.UNSECURED
      : hap.Characteristic.LockCurrentState.SECURED;
  }

  /**
   * Met à jour l'état de la serrure dans HomeKit.
   */
  public updateLockState(isUnlocked: boolean): void {
    this.currentOpenDoorState = isUnlocked;
    this.openDoorService.updateCharacteristic(hap.Characteristic.LockCurrentState, isUnlocked
      ? hap.Characteristic.LockCurrentState.UNSECURED
      : hap.Characteristic.LockCurrentState.SECURED
    );
    this.openDoorService.updateCharacteristic(hap.Characteristic.LockTargetState, isUnlocked
      ? hap.Characteristic.LockTargetState.UNSECURED
      : hap.Characteristic.LockTargetState.SECURED
    );
  }

  /**
   * (Optionnel) Met à jour l’état du bouton "Ouvrir la Porte" dans HomeKit.
   * Cet état est mis à jour soit suite à une commande envoyée, soit via un webhook reçu de Shelly.
   */
  public updateOpenDoorState(newState: boolean): void {
    if (this.currentOpenDoorState !== newState) {
      this.currentOpenDoorState = newState;
      this.platform.log.info(`Mise à jour de l’état "Ouvrir la Porte" pour ${this.config.host} : ${newState ? 'ON' : 'OFF'}`);
      this.openDoorService.updateCharacteristic(this.platform.api.hap.hap.Characteristic.On, newState);
    }
  }

  /**
   * Envoie une commande HTTP GET à l’URL spécifiée.
   */
  private sendHttpCommand(url: string, callback: (err?: Error) => void): void {
    this.platform.log.debug(`Envoi d’une commande HTTP : ${url}`);
    http.get(url, (res) => {
      res.on('data', () => {});
      res.on('end', () => callback());
    }).on('error', (err) => {
      callback(err);
    });
  }
}