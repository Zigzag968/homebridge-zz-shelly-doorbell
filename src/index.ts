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
  CameraControllerOptions, 
  CameraStreamingDelegate,
  SnapshotRequest,
  SnapshotRequestCallback,
  PrepareStreamRequest,
  PrepareStreamCallback,
  StreamingRequest,
  StreamRequestCallback,
  CameraController,
} from 'homebridge';
import * as http from 'http';
import { URL } from 'url';
import * as fs from 'fs';
import { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_PORT } from './settings';
import { UnifiedFfmpegDelegate } from './UnifiedFfmpegDelegate';
import * as path from 'path';
import { spawn } from 'child_process';

const fakeStreetImagePath = path.join(__dirname, 'media', 'fakeStreetImage.jpg');
const fakeStreamPath = "/var/lib/homebridge/node_modules/homebridge-zz-shelly-doorbell/dist/media/fakeStream.mp4"// path.join(__dirname, 'media', 'fakeStream.mp4');

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
// Dans la classe ShellyDoorbellPlatform
discoverDevices(): void {
  const devices = Array.isArray(this.config.devices) 
    ? this.config.devices 
    : [this.config];

  for (const deviceConfig of devices) {
    if (!deviceConfig.host) {
      this.log.error('La configuration d’un dispositif doit inclure la propriété "host".');
      continue;
    }

    // Génère un UUID unique pour ce dispositif
    const uuid = this.api.hap.uuid.generate(deviceConfig.host);

    // Vérifie si l'accessoire existe déjà dans le cache
    let existingAccessory: PlatformAccessory | undefined = this.accessories.find(acc => acc.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Mise à jour de l’accessoire existant :', existingAccessory.displayName);
      existingAccessory.context.device = deviceConfig;
      const shellyAccessory = new ShellyDoorbellAccessory(this, existingAccessory, deviceConfig);
      this.accessoryMap.set(deviceConfig.host, shellyAccessory);
    } else {
      this.log.info('Création d’un nouvel accessoire :', deviceConfig.name || deviceConfig.host);
      const accessory = new this.api.platformAccessory(deviceConfig.name || 'Shelly Doorbell', uuid);
      accessory.context.device = deviceConfig;
      const shellyAccessory = new ShellyDoorbellAccessory(this, accessory, deviceConfig);
      this.accessories.push(accessory);
      this.accessoryMap.set(deviceConfig.host, shellyAccessory);

      // Enregistre le nouvel accessoire auprès de Homebridge
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
        shellyAccessory.updateLockState(true);
        this.log.debug('Webhook reçu : état openDoor -> on');
      } else if (stateParam === 'off') {
        shellyAccessory.updateLockState(false);
        this.log.debug('Webhook reçu : état openDoor -> off');
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
  private readonly lockService: Service;       // Bouton pour ouvrir la porte
  // On maintient en interne l’état du bouton "Ouvrir la Porte"
  private currentOpenDoorState: boolean = false;
  private cameraController?: CameraController;

  constructor(
    private readonly platform: ShellyDoorbellPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: any,
  ) {
    const { Service, Characteristic } = this.platform.api.hap;

    // Accessory Information
    this.informationService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
      .setCharacteristic(Characteristic.Model, 'Shelly 1 Gen 3')
      .setCharacteristic(Characteristic.SerialNumber, config.host);

    // Doorbell Service
    this.doorbellService = accessory.getService(Service.Doorbell)
      || accessory.addService(Service.Doorbell, "Doorbell", "doorbellService");

    // Switch "Test Doorbell"
    this.testButtonService = accessory.getService('Test Doorbell')
      || accessory.addService(Service.Switch, 'Test Doorbell', 'doorbellTest');
    this.testButtonService.getCharacteristic(Characteristic.On)
      .onSet(value => this.handleTestButton(value as boolean))
      .onGet(() => false);

    // Lock Mechanism
    this.lockService = accessory.getService(Service.LockMechanism)
      || accessory.addService(Service.LockMechanism, "Door Lock", "doorLock");
    this.lockService.getCharacteristic(Characteristic.LockTargetState)
      .onSet(this.handleLockTargetState.bind(this))
      .onGet(this.getLockCurrentState.bind(this));

    // Pour éviter l’erreur "already added," on vérifie si on a déjà configuré le cameraController.
    if (!accessory.context.hasCamera) {
      this.setupCameraController();
      accessory.context.hasCamera = true;
    } else {
      this.platform.log.debug('Caméra déjà configurée, on ne la reconfigure pas.');
    }

    this.platform.log.info(`ShellyDoorbellAccessory créé pour ${config.host}`);
  }

  private setupCameraController() {
    const { hap } = this.platform.api;
    const { log } = this.platform;

    // On crée le delegate Ffmpeg
    const ffmpegDelegate = new UnifiedFfmpegDelegate(
      this.platform.log,
      fakeStreetImagePath,
      fakeStreamPath,
      this.accessory.displayName,
      hap,
    );

    const cameraControllerOptions: CameraControllerOptions = {
      delegate: ffmpegDelegate,
      streamingOptions: {
        supportedCryptoSuites: [0],
        video: {
          // ex. [width, height, fps]
          resolutions: [
            [1280, 720, 25],
            [640, 360, 15],
          ],
          codec: {
            profiles: [0, 1, 2],
            levels: [0, 1, 2]
          }
        }
      }
    };

    this.cameraController = new hap.CameraController(cameraControllerOptions);
    this.accessory.configureController(this.cameraController);

    // On peut aussi définir la catégorie de l'accessoire comme CAMÉRA
    this.accessory.category = hap.Categories.CAMERA;
    this.platform.log.info('CameraController configuré pour', this.config.host);
  }

  /**
   * Déclenche l’événement de sonnette (doorbell) dans HomeKit.
   * La caractéristique ProgrammableSwitchEvent est mise à 0 (SINGLE PRESS).
   */
  public triggerDoorbell(): void {
    const { Characteristic } = this.platform.api.hap;
    this.platform.log.info(`Déclenchement de la sonnette pour ${this.config.host}`);
    this.doorbellService.updateCharacteristic(hap.Characteristic.ProgrammableSwitchEvent, hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
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
 * HomeKit demande à changer l'état de la serrure (ouvrir/fermer).
 */
private async handleLockTargetState(value: CharacteristicValue): Promise<void> {
  if (value === hap.Characteristic.LockTargetState.UNSECURED) {
    this.platform.log.info(`Commande de déverrouillage envoyée pour ${this.config.host}`);
    const url = `http://${this.config.host}/rpc/Switch.Set?id=0&on=true`;
    this.sendHttpCommand(url, (err) => {
      if (err) {
        this.platform.log.error(`Erreur lors de la commande d'ouverture : ${err.message}`);
      } else {
        this.platform.log.info(`Porte déverrouillée`);
        this.updateLockState(true); // Simule que la porte est ouverte
      }
    });
  } else if (value === hap.Characteristic.LockTargetState.SECURED) {
    this.platform.log.info(`Commande de verrouillage envoyée pour ${this.config.host}`);
    const url = `http://${this.config.host}/rpc/Switch.Set?id=0&on=false`;
    this.sendHttpCommand(url, (err) => {
      if (err) {
        this.platform.log.error(`Erreur lors de la commande de fermeture : ${err.message}`);
      } else {
        this.platform.log.info(`Porte verrouillée`);
        this.updateLockState(false); // Simule que la porte est fermée
      }
    });
  } else {
    this.platform.log.info(`État de verrouillage non supporté : ${value}`);
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
  this.platform.log.info(`updateLockState appelé avec isUnlocked=${isUnlocked}`);
  const newTargetState = isUnlocked 
      ? hap.Characteristic.LockTargetState.UNSECURED 
      : hap.Characteristic.LockTargetState.SECURED;
  const newCurrentState = isUnlocked 
      ? hap.Characteristic.LockCurrentState.UNSECURED 
      : hap.Characteristic.LockCurrentState.SECURED;
  
  this.lockService.updateCharacteristic(hap.Characteristic.LockTargetState, newTargetState);
  this.platform.log.info(`LockTargetState mis à jour à ${newTargetState}`);
  
  setTimeout(() => {
    this.lockService.updateCharacteristic(hap.Characteristic.LockCurrentState, newCurrentState);
    this.platform.log.info(`LockCurrentState mis à jour à ${newCurrentState}`);
  }, 500);
}

  /**
   * Envoie une commande HTTP GET à l’URL spécifiée.
   */
  private sendHttpCommand(url: string, callback: (err?: Error) => void): void {
    this.platform.log.debug(`Envoi d’une commande HTTP : ${url}`);
    http.get(url, (res: any) => {
      // La réponse n’est pas traitée en détail ici
      res.on('data', () => {});
      res.on('end', () => callback());
    }).on('error', (err: any) => {
      callback(err);
    });
  }
}
class DummyCameraAccessory {
  public cameraController?: CameraController;

  constructor(
    private readonly platform: ShellyDoorbellPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic, CameraController } = this.platform.api.hap;

    // Configuration du service AccessoryInformation
    const infoService = accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, "Dummy Camera")
      .setCharacteristic(Characteristic.Model, "Static Image Camera")
      .setCharacteristic(Characteristic.SerialNumber, "CAM-" + accessory.UUID);

    // Affecter la catégorie CAMERA (ici 26 si hap.Categories n'est pas défini)
    accessory.category = 26;

    // Créer l'instance du délégué FFmpeg en passant undefined pour le CameraController
    const ffmpegDelegate = new UnifiedFfmpegDelegate(
      this.platform.log,
      fakeStreetImagePath,
      fakeStreamPath,
      accessory.displayName,
      hap
    );

    // Définir les options du CameraController
    const cameraControllerOptions: CameraControllerOptions = {
      delegate: ffmpegDelegate,
      streamingOptions: {
        supportedCryptoSuites: [0],
        video: {
          resolutions: [
            [1280, 720, 25]
          ],
          codec: {
            profiles: [0, 1, 2],
            levels: [0, 1, 2]
          }
        }
      }
    };

    // Créer le CameraController avec les options définies
    const cameraControllerInstance = new CameraController(cameraControllerOptions);
    
    accessory.configureController(cameraControllerInstance);
  }
}