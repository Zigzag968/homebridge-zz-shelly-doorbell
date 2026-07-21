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
import { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_PORT, DEFAULT_DOORBELL_DEBOUNCE_MS } from './settings';
import { CustomStreamFfmpegDelegate, FakeStreamFfmpegDelegate, FakeStreamConfig, FakeStreamPath } from './UnifiedFfmpegDelegate';
import { DoorbellDebounce } from './doorbellDebounce';
import * as path from 'path';
import { spawn } from 'child_process';

// Les médias sont copiés dans dist/media/ par le script `move-media` du package.json.
// __dirname pointe sur le répertoire dist/ une fois compilé : on résout les chemins relativement à lui
// pour éviter de dépendre d'un chemin d'installation Homebridge absolu (qui varie selon les setups).
const fakeStreamDayPath = path.join(__dirname, 'media', 'fakeStream_day.mp4');
const fakeStreamNightPath = path.join(__dirname, 'media', 'fakeStream_night.mp4');

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
  }

  /**
   * Découverte des dispositifs définis dans la configuration.
   *
   * Forme OFFICIELLE : un tableau `devices`, chaque entrée décrivant une sonnette
   * (`host` + `streamUrl` + `maxStreams`…). C'est la forme à utiliser.
   *
   * Forme HISTORIQUE « mono » : les champs du device posés directement à la racine
   * de la plateforme, sans tableau `devices`. Conservée uniquement pour la
   * rétro-compatibilité — voir {@link resolveDeviceConfigs} pour le détail et la
   * raison pour laquelle migrer une config mono vers `devices[]` est sans risque.
   */
discoverDevices(): void {
  const devices = this.resolveDeviceConfigs();

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
   * Normalise la configuration vers la forme `devices[]` (liste de dispositifs).
   *
   * ⚠️ COUCHE DE COMPATIBILITÉ — NE PAS SUPPRIMER sans plan de migration.
   *
   * Avant l'introduction de `devices[]`, une sonnette se configurait avec ses champs
   * (`host`, `streamUrl`, …) directement à la racine de la plateforme (« mode mono »).
   * On enveloppe alors cette config racine dans un tableau à un seul élément pour que
   * le reste du code ne connaisse qu'une seule forme.
   *
   * Pourquoi migrer une config mono → `devices[]` est SANS RISQUE pour HomeKit :
   * l'identité d'un accessoire est son UUID, dérivé du `host`
   * (`api.hap.uuid.generate(deviceConfig.host)`), et NON de la forme de la config.
   * Tant que le `host` reste identique, l'UUID est identique → même accessoire,
   * aucun re-pairing, pièce et automatisations conservées.
   *
   * Conséquence inverse — pourquoi la dépréciation est « douce » (warning, pas suppression) :
   * si on retirait ce fallback, une config encore en mode mono ne produirait plus aucun
   * device → l'accessoire ne serait plus publié → il disparaîtrait de HomeKit (perte de la
   * pièce et des automatisations). Ce n'est pas un changement d'identité, mais une absence
   * de publication. On garde donc le fallback et on se contente d'inviter à migrer.
   *
   * INVARIANT CRITIQUE : ne jamais changer la graine de l'UUID (`host`). Générer l'UUID
   * depuis autre chose (ex. `name`) ferait re-pairer TOUS les accessoires existants.
   */
  private resolveDeviceConfigs(): any[] {
    if (Array.isArray(this.config.devices)) {
      return this.config.devices;
    }

    // Compat « mono » (dépréciée) : on ne prévient que s'il y a réellement une sonnette
    // configurée à la racine ; sinon l'absence de `host` est gérée plus bas comme une erreur.
    if (this.config.host) {
      this.log.warn(
        'Config « mono » dépréciée : déclarez votre sonnette dans le tableau '
        + '"devices": [ { "host": "…", "streamUrl": "…" } ]. La forme actuelle reste '
        + 'supportée (rétro-compatibilité) et votre accessoire HomeKit est préservé '
        + '(son identité dépend du "host", pas de la forme de config) — aucune action urgente.',
      );
    }

    return [this.config];
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
  private readonly doorbellButtonService: Service;     // Bouton de test pour la sonnette
  private readonly lockService: Service;       // Bouton pour ouvrir la porte
  // On maintient en interne l’état du bouton "Ouvrir la Porte"
  private currentOpenDoorState: boolean = false;
  private cameraController?: CameraController;
  private readonly doorbellDebounce: DoorbellDebounce;

  constructor(
    private readonly platform: ShellyDoorbellPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: any,
  ) {
    const { Service, Characteristic } = this.platform.api.hap;

    const debounceMs = Number.isFinite(Number(config.doorbellDebounceMs))
      ? Number(config.doorbellDebounceMs)
      : DEFAULT_DOORBELL_DEBOUNCE_MS;
    this.doorbellDebounce = new DoorbellDebounce(debounceMs);

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
    
    // Doorbell Service configuration
    this.doorbellService.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .on('change', this.handleDoorbellChange.bind(this));

    // Doorbell Button
    this.doorbellButtonService = accessory.getService('Doorbell button')
      || accessory.addService(Service.Switch, 'Doorbell button', 'doorbellButton');
    
    this.doorbellButtonService.getCharacteristic(Characteristic.On)
      .onSet(this.handleDoorbellButtonSet.bind(this))
      .onGet(this.handleDoorbellButtonGet.bind(this));

    // Lock Mechanism
    this.lockService = accessory.getService(Service.LockMechanism)
      || accessory.addService(Service.LockMechanism, "Door Lock", "doorLock");
    this.lockService.getCharacteristic(Characteristic.LockTargetState)
      .onSet(this.handleLockTargetState.bind(this))
      .onGet(this.getLockCurrentState.bind(this));

    if (this.hasConfiguredStream()) {
      this.setupCameraController();
    } else {
      this.disableCameraController();
    }

    this.platform.log.info(`ShellyDoorbellAccessory créé pour ${config.host}`);
  }

  private hasConfiguredStream(): boolean {
    const url = this.config.streamUrl;
    const hasRealStream = typeof url === 'string' && url.trim().length > 0;
    const useFakeFallback = this.config.useFakeStreamWhenNoUrl === true;
    return hasRealStream || useFakeFallback;
  }

  private setupCameraController() {
    const { hap } = this.platform.api;
    const { log } = this.platform;

    let ffmpegDelegate;

    const hasRealStream = typeof this.config.streamUrl === 'string' && this.config.streamUrl.trim().length > 0;

    if (hasRealStream) {
      ffmpegDelegate = new CustomStreamFfmpegDelegate(
      this.platform.log,
      this.config.streamUrl,
      this.accessory.displayName,
      hap,
      );
      this.platform.log.info(`Utilisation du flux personnalisé pour ${this.config.host}`);
    } else {
      ffmpegDelegate = new FakeStreamFfmpegDelegate(
      this.platform.log,
      new FakeStreamConfig(new FakeStreamPath(fakeStreamDayPath, fakeStreamNightPath), 52.520008, 13.404954),
      this.accessory.displayName,
      hap,
      );
      this.platform.log.info(`Utilisation du flux de démonstration pour ${this.config.host} (aucune streamUrl fournie, useFakeStreamWhenNoUrl=true)`);
    }

    // Nombre de flux live simultanés autorisés (Apple TV, iPhone, iPad…).
    // HomeKit limite à 1 par défaut. go2rtc protège la caméra (fan-out depuis 1
    // seule connexion) et le plugin ne fait que recopier le flux (`-c:v copy`),
    // donc on peut autoriser jusqu'à 6 sessions sans risque pour la cam.
    const maxStreams = Math.min(Math.max(Number(this.config.maxStreams) || 3, 1), 6);

    const cameraControllerOptions: CameraControllerOptions = {
      cameraStreamCount: maxStreams,
      delegate: ffmpegDelegate,
      streamingOptions: {
        supportedCryptoSuites: [0],
        video: {
          // ex. [width, height, fps]
          resolutions: [
            [1280, 720, 24],
            [1920, 1080, 30],
            [1920, 1080, 24],
            [1280, 720, 30],
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
    this.platform.log.info(`Flux live simultanés autorisés pour ${this.config.host} : ${maxStreams}`);

    // On peut aussi définir la catégorie de l'accessoire comme CAMÉRA
    this.accessory.category = hap.Categories.CAMERA;
    this.platform.log.info('CameraController configuré pour', this.config.host);
  }

  private disableCameraController(): void {
    const { hap } = this.platform.api;
    const accessoryWithCamera = this.accessory as unknown as {
      removeController: (controller: CameraController) => void;
      activeCameraController?: CameraController;
    };

    const existingCamera = accessoryWithCamera.activeCameraController;
    if (existingCamera) {
      try {
        accessoryWithCamera.removeController(existingCamera);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.platform.log.debug(`Impossible de retirer le module caméra existant pour ${this.config.host} : ${message}`);
      }
    }

    this.cameraController = undefined;
    this.accessory.category = hap.Categories.DOOR_LOCK;
    this.platform.log.info(`Module caméra désactivé pour ${this.config.host} (aucun flux configuré).`);
  }

  /**
   * Déclenche l’événement de sonnette (doorbell) dans HomeKit.
   * La caractéristique ProgrammableSwitchEvent est mise à 0 (SINGLE PRESS).
   */
  public triggerDoorbell(): void {
    const { Characteristic } = this.platform.api.hap;
    if (!this.doorbellDebounce.shouldTrigger()) {
      this.platform.log.info(`Ring ignoré pour ${this.config.host} (trop rapproché du précédent, anti-rebond actif)`);
      return;
    }
    this.platform.log.info(`Déclenchement de la sonnette pour ${this.config.host}`);
    this.doorbellService.updateCharacteristic(hap.Characteristic.ProgrammableSwitchEvent, hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
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

private handleDoorbellButtonGet(): boolean {
  return false;
}

private handleDoorbellButtonSet(value: CharacteristicValue): void {
  if (value as boolean) {
  this.triggerDoorbell();
  }
}

private handleDoorbellChange(): void {
  // When doorbell is triggered, set doorbell button to ON temporarily
  this.doorbellButtonService.updateCharacteristic(this.platform.api.hap.Characteristic.On, true);
  setTimeout(() => {
  this.doorbellButtonService.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
  }, 1000);
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