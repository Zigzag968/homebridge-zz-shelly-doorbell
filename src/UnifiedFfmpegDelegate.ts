import {
  CameraStreamingDelegate,
  StartStreamRequest,
  StreamRequestCallback,
  StreamingRequest,
  StreamRequestTypes,
  Logger,
  PrepareStreamRequest,
  PrepareStreamCallback,
  HAP
} from 'homebridge';
import { spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import { pickPort, Type } from 'pick-port';
import { getTimes } from 'suncalc';

//
// Interfaces pour stocker les informations de session
//
interface SessionInfo {
  address: string;         // Adresse du contrôleur HAP
  ipv6: boolean;
  sessionID: string;
  videoPort: number;
  videoReturnPort: number;
  videoSRTP: Buffer;       // Clé et salt concaténés pour la vidéo
  videoSSRC: number;       // Identifiant de synchronisation pour la vidéo
  audioPort: number;
  audioReturnPort: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ActiveSession {
  socket?: Socket;
  mainProcess?: any;       // Processus FFmpeg lancé pour le flux
  returnProcess?: any;
  timeout?: NodeJS.Timeout;
}

export class FakeStreamConfig {
  private readonly videoPath: FakeStreamPath;
  private readonly cityLat: number;
  private readonly cityLon: number;

constructor(videoPath: FakeStreamPath, cityLat: number, cityLon: number) {
  this.videoPath = videoPath;
  this.cityLat = cityLat;
  this.cityLon = cityLon;
}

getVideoPath(): string {
  const times = getTimes(new Date(), this.cityLat, this.cityLon);
  const now = new Date();
  const isNight = now < times.sunrise || now > times.sunset;
  return this.videoPath.getPath(isNight);
}
}

export class FakeStreamPath {
  private readonly day: string;
  private readonly night: string;

  constructor(day: string, night: string) {
    this.day = day;
    this.night = night;
  }

  getPath(isNight: boolean): string {
    return isNight ? this.night : this.day;
  }
}

//
// Zone de recadrage (crop / bounding box) exprimée en pourcentages (0–100).
//
export interface CropRegion {
  x: number;      // décalage depuis la gauche, en %
  y: number;      // décalage depuis le haut, en %
  width: number;  // largeur de la zone, en %
  height: number; // hauteur de la zone, en %
}

/**
 * Construit un filtre FFmpeg "crop" à partir de pourcentages (0–100).
 *
 * Les expressions sont évaluées par FFmpeg en fonction de la résolution réelle
 * de la source (in_w / in_h), donc aucune résolution fixe n'est nécessaire :
 * la même config fonctionne quelle que soit la caméra.
 * Les dimensions sont arrondies à un nombre pair (requis par H.264 / yuv420p).
 *
 * Renvoie null si la configuration est absente ou invalide (le flux est alors
 * diffusé sans recadrage).
 */
export function buildCropFilter(
  crop: CropRegion | undefined,
  log?: Logger,
  cameraName = '',
): string | null {
  if (!crop) {
    return null;
  }

  const values = [crop.x, crop.y, crop.width, crop.height];
  if (values.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
    log?.warn(`[${cameraName}] crop ignoré : x, y, width et height doivent être des nombres (en %).`);
    return null;
  }

  // Borne chaque valeur dans [0, 100].
  let x = Math.min(Math.max(crop.x, 0), 100);
  let y = Math.min(Math.max(crop.y, 0), 100);
  let width = Math.min(Math.max(crop.width, 0), 100);
  let height = Math.min(Math.max(crop.height, 0), 100);

  if (width <= 0 || height <= 0) {
    log?.warn(`[${cameraName}] crop ignoré : width et height doivent être > 0.`);
    return null;
  }

  // Garde la zone à l'intérieur de l'image.
  if (x + width > 100) {
    width = 100 - x;
  }
  if (y + height > 100) {
    height = 100 - y;
  }

  // Expressions évaluées par FFmpeg ; /2*2 force des dimensions paires.
  const w = `floor(in_w*${width}/100/2)*2`;
  const h = `floor(in_h*${height}/100/2)*2`;
  const px = `floor(in_w*${x}/100)`;
  const py = `floor(in_h*${y}/100)`;
  log?.info(`[${cameraName}] crop appliqué : x=${x}% y=${y}% w=${width}% h=${height}%`);
  return `crop=${w}:${h}:${px}:${py}`;
}
//
// Delegate utilisant FFmpeg pour générer un snapshot et un flux vidéo continu
//
export class FakeStreamFfmpegDelegate implements CameraStreamingDelegate {
  // Maps pour gérer les sessions en attente et actives.
  private pendingSessions: Map<string, SessionInfo> = new Map();
  private ongoingSessions: Map<string, ActiveSession> = new Map();

  constructor(
    private readonly log: Logger,
    private readonly config: FakeStreamConfig,
    private readonly cameraName: string,
    private readonly hap: HAP,
  ) {}

  // ========================================================
  // 1) PREPARE STREAM (négociation avec HomeKit)
  // ========================================================
  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    this.log.info(`[${this.cameraName}] prepareStream: sessionID = ${request.sessionID}`);

    const options = {
      type: "udp" as Type,
      ip: request.addressVersion === 'ipv6' ? '::' : '0.0.0.0',
      reserveTimeout: 15,
    };
    const videoReturnPort = await pickPort(options);
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await pickPort(options);
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      sessionID: request.sessionID,
      address: request.targetAddress,
      ipv6: request.addressVersion === 'ipv6',
      videoPort: request.video.port,
      audioPort: request.audio.port,
      videoReturnPort: videoReturnPort,
      audioReturnPort: audioReturnPort,
      videoSRTP: Buffer.concat([
        request.video.srtp_key, // Assurez-vous que cette valeur fait 16 octets
        request.video.srtp_salt  // Assurez-vous que cette valeur fait 14 octets
      ]),
      audioSRTP: Buffer.concat([
        request.audio.srtp_key,
        request.audio.srtp_salt
      ]),
      videoSSRC: videoSSRC,
      audioSSRC: audioSSRC,
    };
    this.log.info(`PrepareStream: cible = ${request.targetAddress}, port vidéo = ${request.video.port}, port audio = ${request.audio.port}`);
    this.log.info("Video SRTP key:", request.video.srtp_key);
    this.log.info("Audio SRTP key:", request.audio.srtp_key);

    this.pendingSessions.set(request.sessionID, sessionInfo);

    const response = {
      video: {
        port: sessionInfo.videoPort, // Utiliser la variable sessionInfo
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: request.audio.port,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    this.log.info(`[${this.cameraName}] prepareStream: réponse renvoyée à HomeKit`);
    callback(undefined, response);
  }

  // ========================================================
  // 2) HANDLE SNAPSHOT REQUEST (une seule image en MJPEG)
  // ========================================================
  handleSnapshotRequest(request: any, callback: (error: Error | undefined, snapshot?: Buffer) => void): void {
    this.log.info(`[${this.cameraName}] handleSnapshotRequest: lancement du snapshot via FFmpeg`);
    // Construction de la commande FFmpeg pour un snapshot
    // On utilise "-frames:v 1 -vsync 0" pour capturer une unique image.
    const ffmpegArgs = `-i ${this.config.getVideoPath()} -frames:v 1 -vf scale=1920:1080:force_original_aspect_ratio=decrease -f mjpeg -hide_banner -loglevel error -`;
    this.log.info(`[${this.cameraName}] FFmpeg snapshot command: ffmpeg ${ffmpegArgs}`);

    const args = ffmpegArgs.split(' ');
    const ffmpegProc = spawn('ffmpeg', args, { env: process.env });
    let snapshotBuffer = Buffer.alloc(0);

    ffmpegProc.stdout.on('data', (data) => {
      snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
    });

    ffmpegProc.on('error', (error: Error) => {
      this.log.error(`[${this.cameraName}] FFmpeg snapshot error: ${error.message}`);
      callback(error);
    });

    ffmpegProc.on('close', () => {
      this.log.info(`[${this.cameraName}] FFmpeg snapshot terminé`);
      if (snapshotBuffer.length > 0) {
        callback(undefined, snapshotBuffer);
      } else {
        callback(new Error('Snapshot buffer vide.'));
      }
    });
  }

  // ========================================================
  // 3) HANDLE STREAM REQUEST (START, RECONFIGURE, STOP)
  // ========================================================
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    this.log.info(`[${this.cameraName}] handleStreamRequest: sessionID = ${request.sessionID}, type = ${request.type}`);
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request as StartStreamRequest, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.info(`[${this.cameraName}] Reconfigure request ignorée.`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  // --------------------------------------------------------
  // Méthode pour démarrer un flux vidéo continu
  // --------------------------------------------------------
  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      this.log.error(`[${this.cameraName}] startStream: SessionInfo introuvable pour sessionID ${request.sessionID}`);
      callback(new Error('Session introuvable'));
      return;
    }
  
    this.log.info(`[${this.cameraName}] startStream: lancement du flux pour sessionID = ${request.sessionID}`);
  
    const mtu = 1316;
    const fps = request.video.fps;              // Utilisez le framerate négocié
    const videoBitrate = request.video.max_bit_rate; // Bitrate négocié

    const ffmpegArgsArray = [
      '-re',
      '-i', this.config.getVideoPath(),
      '-loglevel', 'error', // Change 'error' to 'info' to log more details
      '-an', '-sn', '-dn',
      '-codec:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-r', `${fps}`,
      '-b:v', `${videoBitrate}k`,
      '-f', 'rtp',
      '-payload_type', '99',
      '-ssrc', `${sessionInfo.videoSSRC}`,
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', sessionInfo.videoSRTP.toString('base64'),
      `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`
    ];

    this.log.info(`[${this.cameraName}] FFmpeg stream command: ffmpeg ${ffmpegArgsArray.join(' ')}`);
    const ffmpegProc = spawn('ffmpeg', ffmpegArgsArray, { env: process.env });
  
    ffmpegProc.on('error', (err: Error) => {
      this.log.error(`[${this.cameraName}] FFmpeg stream error: ${err.message}`);
      callback(err);
    });
  
    ffmpegProc.stderr.on('data', (data) => {
      this.log.error(`[${this.cameraName}] FFmpeg stderr: ${data.toString()}`);
    });
  
    ffmpegProc.on('close', (code, signal) => {
      this.log.info(`[${this.cameraName}] FFmpeg stream terminé (code=${code}, signal=${signal})`);
      this.stopStream(request.sessionID);
    });
  
    const activeSession: ActiveSession = { mainProcess: ffmpegProc };
    this.ongoingSessions.set(request.sessionID, activeSession);
    this.pendingSessions.delete(request.sessionID);
  
    // Signaler à HomeKit que le flux est démarré
    callback();
  }

  // --------------------------------------------------------
  // Méthode pour arrêter un flux
  // --------------------------------------------------------
  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      if (session.mainProcess) {
        this.log.info(`[${this.cameraName}] stopStream: arrêt du process FFmpeg pour sessionID = ${sessionID}`);
        try {
          session.mainProcess.kill('SIGKILL');
        } catch (err) {
          this.log.error(`[${this.cameraName}] Erreur lors de l'arrêt de FFmpeg: ${err}`);
        }
      }
      if (session.socket) {
        session.socket.close();
      }
      this.ongoingSessions.delete(sessionID);
    }
  }
}

export class CustomStreamFfmpegDelegate implements CameraStreamingDelegate {
  private pendingSessions: Map<string, SessionInfo> = new Map();
  private ongoingSessions: Map<string, ActiveSession> = new Map();
  private readonly cropFilter: string | null;

  constructor(
    private readonly log: Logger,
    private readonly customStreamUrl: string,
    private readonly cameraName: string,
    private readonly hap: HAP,
    crop?: CropRegion,
  ) {
    this.cropFilter = buildCropFilter(crop, this.log, this.cameraName);
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    this.log.info(`[${this.cameraName}] prepareStream: sessionID = ${request.sessionID}`);

    const options = {
      type: "udp" as Type,
      ip: request.addressVersion === 'ipv6' ? '::' : '0.0.0.0',
      reserveTimeout: 15,
    };
    const videoReturnPort = await pickPort(options);
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await pickPort(options);
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      sessionID: request.sessionID,
      address: request.targetAddress,
      ipv6: request.addressVersion === 'ipv6',
      videoPort: request.video.port,
      audioPort: request.audio.port,
      videoReturnPort: videoReturnPort,
      audioReturnPort: audioReturnPort,
      videoSRTP: Buffer.concat([
        request.video.srtp_key,
        request.video.srtp_salt
      ]),
      audioSRTP: Buffer.concat([
        request.audio.srtp_key,
        request.audio.srtp_salt
      ]),
      videoSSRC: videoSSRC,
      audioSSRC: audioSSRC,
    };
    this.log.info(`PrepareStream: cible = ${request.targetAddress}, port vidéo = ${request.video.port}, port audio = ${request.audio.port}`);
    this.log.info("Video SRTP key:", request.video.srtp_key);
    this.log.info("Audio SRTP key:", request.audio.srtp_key);

    this.pendingSessions.set(request.sessionID, sessionInfo);

    const response = {
      video: {
        port: sessionInfo.videoPort,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: request.audio.port,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    this.log.info(`[${this.cameraName}] prepareStream: réponse renvoyée à HomeKit`);
    callback(undefined, response);
  }

  handleSnapshotRequest(request: any, callback: (error: Error | undefined, snapshot?: Buffer) => void): void {
    this.log.info(`[${this.cameraName}] handleSnapshotRequest: lancement du snapshot via FFmpeg`);
    // On recadre (si configuré) avant de mettre à l'échelle.
    const vf = this.cropFilter
      ? `${this.cropFilter},scale=1920:1080:force_original_aspect_ratio=decrease`
      : `scale=1920:1080:force_original_aspect_ratio=decrease`;
    // -rtsp_transport tcp : évite les images corrompues sur les flux RTSP/HEVC en UDP.
    const ffmpegArgs = `-rtsp_transport tcp -i ${this.customStreamUrl} -frames:v 1 -vf ${vf} -f mjpeg -hide_banner -loglevel error -`;
    this.log.info(`[${this.cameraName}] FFmpeg snapshot command: ffmpeg ${ffmpegArgs}`);

    const args = ffmpegArgs.split(' ');
    const ffmpegProc = spawn('ffmpeg', args, { env: process.env });
    let snapshotBuffer = Buffer.alloc(0);

    ffmpegProc.stdout.on('data', (data) => {
      snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
    });

    ffmpegProc.on('error', (error: Error) => {
      this.log.error(`[${this.cameraName}] FFmpeg snapshot error: ${error.message}`);
      callback(error);
    });

    ffmpegProc.on('close', () => {
      this.log.info(`[${this.cameraName}] FFmpeg snapshot terminé`);
      if (snapshotBuffer.length > 0) {
        callback(undefined, snapshotBuffer);
      } else {
        callback(new Error('Snapshot buffer vide.'));
      }
    });
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    this.log.info(`[${this.cameraName}] handleStreamRequest: sessionID = ${request.sessionID}, type = ${request.type}`);
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request as StartStreamRequest, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.info(`[${this.cameraName}] Reconfigure request ignorée.`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      this.log.error(`[${this.cameraName}] startStream: SessionInfo introuvable pour sessionID ${request.sessionID}`);
      callback(new Error('Session introuvable'));
      return;
    }

    this.log.info(`[${this.cameraName}] startStream: lancement du flux pour sessionID = ${request.sessionID}`);

    const mtu = 1316;
    const fps = request.video.fps;
    const videoBitrate = request.video.max_bit_rate;

    const ffmpegArgsArray = [
      // --- Entrée RTSP en faible latence ---
      // PAS de "-re" : la source est déjà temps réel ; "-re" ne sert qu'à rejouer
      // un fichier et introduirait une latence croissante sur un flux live.
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer',      // ne pas accumuler de paquets en entrée
      '-flags', 'low_delay',      // décodage sans réordonnancement
      '-reorder_queue_size', '0', // pas de file de réordonnancement RTP (TCP = déjà ordonné)
      '-i', this.customStreamUrl,
      '-loglevel', 'error',
      '-an', '-sn', '-dn',
      ...(this.cropFilter ? ['-vf', this.cropFilter] : []),
      // --- Encodage H.264 sans latence ---
      '-codec:v', 'libx264',
      '-preset', 'ultrafast',     // encodage le plus rapide (moins de CPU, idéal multi-flux)
      '-tune', 'zerolatency',     // pas de B-frames ni de lookahead
      '-pix_fmt', 'yuv420p',
      '-bf', '0',                 // aucune B-frame (pas de réordonnancement)
      '-r', `${fps}`,
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${videoBitrate}k`,
      '-bufsize', `${Math.max(1, Math.round(videoBitrate / 2))}k`, // petit VBV = faible latence
      '-muxdelay', '0',           // pas de délai au muxer RTP
      '-f', 'rtp',
      '-payload_type', '99',
      '-ssrc', `${sessionInfo.videoSSRC}`,
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', sessionInfo.videoSRTP.toString('base64'),
      `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`
    ];

    this.log.info(`[${this.cameraName}] FFmpeg stream command: ffmpeg ${ffmpegArgsArray.join(' ')}`);
    const ffmpegProc = spawn('ffmpeg', ffmpegArgsArray, { env: process.env });

    ffmpegProc.on('error', (err: Error) => {
      this.log.error(`[${this.cameraName}] FFmpeg stream error: ${err.message}`);
      callback(err);
    });

    ffmpegProc.stderr.on('data', (data) => {
      this.log.error(`[${this.cameraName}] FFmpeg stderr: ${data.toString()}`);
    });

    ffmpegProc.on('close', (code, signal) => {
      this.log.info(`[${this.cameraName}] FFmpeg stream terminé (code=${code}, signal=${signal})`);
      this.stopStream(request.sessionID);
    });

    const activeSession: ActiveSession = { mainProcess: ffmpegProc };
    this.ongoingSessions.set(request.sessionID, activeSession);
    this.pendingSessions.delete(request.sessionID);

    callback();
  }

  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      if (session.mainProcess) {
        this.log.info(`[${this.cameraName}] stopStream: arrêt du process FFmpeg pour sessionID = ${sessionID}`);
        try {
          session.mainProcess.kill('SIGKILL');
        } catch (err) {
          this.log.error(`[${this.cameraName}] Erreur lors de l'arrêt de FFmpeg: ${err}`);
        }
      }
      if (session.socket) {
        session.socket.close();
      }
      this.ongoingSessions.delete(sessionID);
    }
  }
}