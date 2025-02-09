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
} from 'homebridge';
import * as http from 'http';
import { URL } from 'url';
import * as fs from 'fs';
import { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_PORT } from './settings';
import * as path from 'path';

const fakeStreetImagePath = path.join(__dirname, 'media', 'fakeStreetImagePath.jpg');

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
  const devices = (this.config.devices && Array.isArray(this.config.devices))
      ? this.config.devices
      : [this.config];
  for (const deviceConfig of devices) {
    if (!deviceConfig.host) {
      this.log.error('La configuration d’un dispositif doit inclure la propriété "host".');
      continue;
    }

    // --- Création de l'accessoire porte (serrure) ---
    const lockUUID = this.api.hap.uuid.generate(deviceConfig.host);
    let lockAccessory = this.accessories.find(acc => acc.UUID === lockUUID);
    if (lockAccessory) {
      this.log.info('Restauration de l’accessoire porte existant :', lockAccessory.displayName);
      lockAccessory.context.device = deviceConfig;
      // Optionnel : forcer la catégorie si besoin (ex. INTERCOM pour enrichir la notification)
      // lockAccessory.category = INTERCOM_CATEGORY; // si vous en avez défini une
      new ShellyDoorbellAccessory(this, lockAccessory, deviceConfig);
      this.accessoryMap.set(deviceConfig.host, new ShellyDoorbellAccessory(this, lockAccessory, deviceConfig));
    } else {
      this.log.info('Ajout d’un nouvel accessoire porte :', deviceConfig.name || deviceConfig.host);
      lockAccessory = new this.api.platformAccessory(deviceConfig.name || 'Shelly Door', lockUUID);
      lockAccessory.context.device = deviceConfig;
      new ShellyDoorbellAccessory(this, lockAccessory, deviceConfig);
      this.accessories.push(lockAccessory);
      this.accessoryMap.set(deviceConfig.host, new ShellyDoorbellAccessory(this, lockAccessory, deviceConfig));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [lockAccessory]);
    }

    // --- Création de l'accessoire caméra dummy ---
    const cameraUUID = this.api.hap.uuid.generate("camera-" + deviceConfig.host);
    let cameraAccessory = this.accessories.find(acc => acc.UUID === cameraUUID);
    if (cameraAccessory) {
      this.log.info('Restauration de l’accessoire caméra existant :', cameraAccessory.displayName);
      cameraAccessory.context.device = deviceConfig;
      new DummyCameraAccessory(this, cameraAccessory);
    } else {
      this.log.info('Ajout d’un nouvel accessoire caméra pour', deviceConfig.host);
      cameraAccessory = new this.api.platformAccessory(deviceConfig.name ? deviceConfig.name + " Camera" : "Dummy Camera", cameraUUID);
      cameraAccessory.context.device = deviceConfig;
      new DummyCameraAccessory(this, cameraAccessory);
      this.accessories.push(cameraAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cameraAccessory]);
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
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Shelly')
      .setCharacteristic(hap.Characteristic.Model, 'Shelly 1 Gen 3')
      .setCharacteristic(hap.Characteristic.SerialNumber, config.host);

    // Service de sonnette (Stateless Programmable Switch)
    this.doorbellService = accessory.getService(Service.Doorbell) ||
      accessory.addService(Service.Doorbell, "Doorbell", "doorbellService");

    // Bouton de test pour simuler la sonnette
    this.testButtonService =
      accessory.getService('Test Doorbell') || accessory.addService(Service.Switch, 'Test Doorbell', 'doorbellTest');
    this.testButtonService.getCharacteristic(hap.Characteristic.On)
      .onSet((value: CharacteristicValue) => this.handleTestButton(value as boolean))
      .onGet(() => false);

    // Bouton pour ouvrir la porte
    this.openDoorService = accessory.getService(Service.LockMechanism) ||
    accessory.addService(Service.LockMechanism, "Door Lock", "doorLock");
    
    this.openDoorService.getCharacteristic(hap.Characteristic.LockTargetState)
    .onSet(this.handleLockTargetState.bind(this))
    .onGet(this.getLockCurrentState.bind(this));
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
  
  this.openDoorService.updateCharacteristic(hap.Characteristic.LockTargetState, newTargetState);
  this.platform.log.info(`LockTargetState mis à jour à ${newTargetState}`);
  
  setTimeout(() => {
    this.openDoorService.updateCharacteristic(hap.Characteristic.LockCurrentState, newCurrentState);
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
  constructor(
    private readonly platform: ShellyDoorbellPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic, CameraController } = this.platform.api.hap;

    // Configuration des informations de l'accessoire
    const infoService = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, "Dummy Camera")
      .setCharacteristic(Characteristic.Model, "Static Image Camera")
      .setCharacteristic(Characteristic.SerialNumber, "CAM-" + accessory.UUID);

    // Affecter la catégorie CAMERA (généralement 26, ou utilisez hap.Categories.CAMERA si disponible)
    // Par exemple, si hap.Categories n'est pas défini, on peut utiliser 26.
    accessory.category = 26;

    function readFileWithTimeout(filePath: string, timeout: number): Promise<Buffer> {
      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timeout lors de la lecture du fichier."));
        }, timeout);
    
        fs.promises.readFile(filePath)
          .then((data) => {
            clearTimeout(timer);
            resolve(data);
          })
          .catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
      });
    }

    const redPixelJpegBase64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFwAAAwEAAAAAAAAAAAAAAAAAAAMEB//EABYBAQEBAAAAAAAAAAAAAAAAAAABAv/aAAgBAQABBQL//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//9k=";
    const redImageBuffer = Buffer.from(redPixelJpegBase64, 'base64');
    // Implémenter le délégué de streaming qui retourne toujours la même image
    const streamingDelegate: CameraStreamingDelegate = {
      async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback) {
        callback(undefined, redImageBuffer);
      },
        /**
       * Prépare le flux. Ici, nous renvoyons simplement un objet "dummy" qui reprend certaines valeurs
       * présentes dans la requête. Cette réponse n'est utilisée que pour la négociation du flux.
       */
      async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback) {
      // Log pour déboguer
      console.info("DummyCameraAccessory: prepareStream appelée");
      // Retourne une réponse dummy basée sur la requête
      callback(undefined, {
        video: {
          ssrc: 1,
          port: request.video.port,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt
        }
      });
      },
      /**
         * Gère la requête de flux.
         * Ici, nous renvoyons simplement l'image statique pour toute demande de flux.
         */
      async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback) {
        callback(undefined);
      }
    };

    // Définir les options du contrôleur caméra selon l'interface CameraControllerOptions
    const cameraControllerOptions: CameraControllerOptions = {
      delegate: streamingDelegate,
      streamingOptions: {
      supportedCryptoSuites: [0],
      video: {
        resolutions: [
        [640, 480, 15],
        [320, 240, 15],
        [1280, 720, 15]
        ],
        codec: {
        profiles: [0, 1, 2],
        levels: [0, 1, 2]
        }
      }
      }
    };

    // Créer le contrôleur caméra avec les options définies
    const cameraController = new CameraController(cameraControllerOptions);

    // Associer le contrôleur à l'accessoire
    accessory.configureController(cameraController);
  }
}