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
  videoSSRC: number;       // Identifiant de synchronisation RTP pour la vidéo
  audioPort: number;
  audioReturnPort: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ActiveSession {
  socket?: Socket;
  mainProcess?: any;       // Processus FFmpeg lancé pour le flux
  returnProcess?: any;     // Pour le retour audio, si nécessaire
  timeout?: NodeJS.Timeout;
}

//
// Delegate utilisant FFmpeg pour générer un snapshot et un stream
//
export class UnifiedFfmpegDelegate implements CameraStreamingDelegate {

  // Ces maps gèrent les sessions en attente et en cours.
  private pendingSessions: Map<string, SessionInfo> = new Map();
  private ongoingSessions: Map<string, ActiveSession> = new Map();

  constructor(
    private readonly log: Logger,
    private readonly source: string,   // Par exemple: "-i /path/to/fakeStreetImage.jpg" ou juste "/path/to/fakeStreetImage.jpg"
    private readonly cameraName: string,
    private readonly hap: HAP,
  ) {
    // Rien de particulier ici.
  }

  // ---------------------------------------------------
  // 1) PREPARE STREAM
  // ---------------------------------------------------
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

    // Création de l'objet SessionInfo
    const sessionInfo: SessionInfo = {
      sessionID: request.sessionID,
      address: request.targetAddress,
      ipv6: request.addressVersion === 'ipv6',
      videoPort: request.video.port,
      audioPort: request.audio.port,
      videoReturnPort: videoReturnPort,
      audioReturnPort: audioReturnPort,
      videoSRTP: request.video.srtp_key,
      audioSRTP: request.audio.srtp_key,
      videoSSRC: videoSSRC,
      audioSSRC: audioSSRC,
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);

    const response = {
      video: {
        port: request.video.port,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key.slice(0, 16),
        srtp_salt: request.video.srtp_key.slice(16, 30),
      },
      audio: {
        port: request.audio.port,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key.slice(0, 16),
        srtp_salt: request.audio.srtp_key.slice(16, 30),
      },
    };

    this.log.info(`[${this.cameraName}] prepareStream: réponse renvoyée à HomeKit`);
    callback(undefined, response);
  }

  // ---------------------------------------------------
  // 2) HANDLE SNAPSHOT REQUEST
  // ---------------------------------------------------
  handleSnapshotRequest(request: any, callback: (error: Error | undefined, snapshot?: Buffer) => void): void {
    this.log.info(`[${this.cameraName}] handleSnapshotRequest: lancement de FFmpeg en mode snapshot`);
    // Construction des arguments FFmpeg pour capturer une image unique.
    // On suppose que "this.source" contient le chemin ou l'option FFmpeg d'entrée.
    const ffmpegArgs = `${this.source} -frames:v 1 -f mjpeg -hide_banner -loglevel error -`;
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

  // ---------------------------------------------------
  // 3) HANDLE STREAM REQUEST
  // ---------------------------------------------------
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
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

  // Méthode pour démarrer un flux vidéo continu
  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      this.log.error(`[${this.cameraName}] SessionInfo introuvable pour sessionID ${request.sessionID}`);
      callback(new Error('Session introuvable'));
      return;
    }

    this.log.info(`[${this.cameraName}] startStream: lancement de FFmpeg en mode flux pour sessionID = ${request.sessionID}`);
    // Exemple : Utiliser la source en mode stream en boucle (-loop 1) pour simuler un flux continu
    const mtu = 1316;
    const fps = request.video.fps;
    const videoBitrate = request.video.max_bit_rate;
    let ffmpegArgs = `-re -loop 1 ${this.source}`;
    ffmpegArgs += ` -an -sn -dn`;
    ffmpegArgs += ` -codec:v libx264 -pix_fmt yuv420p -r ${fps} -b:v ${videoBitrate}k`;
    ffmpegArgs += ` -f rawvideo`;
    ffmpegArgs += ` -ssrc ${sessionInfo.videoSSRC} -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80`;
    ffmpegArgs += ` -srtp_out_params ${sessionInfo.videoSRTP.toString('base64')}`;
    ffmpegArgs += ` srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`;
    ffmpegArgs += ` -loglevel level+verbose`;

    this.log.info(`[${this.cameraName}] FFmpeg stream command: ffmpeg ${ffmpegArgs}`);
    const args = ffmpegArgs.split(' ');
    const ffmpegProc = spawn('ffmpeg', args, { env: process.env });

    ffmpegProc.on('error', (err: Error) => {
      this.log.error(`[${this.cameraName}] FFmpeg stream error: ${err.message}`);
      callback(err);
    });

    ffmpegProc.on('close', (code, signal) => {
      this.log.info(`[${this.cameraName}] FFmpeg stream terminé (code=${code}, signal=${signal})`);
      this.stopStream(request.sessionID);
    });

    // Création d'une session active
    const activeSession: ActiveSession = { mainProcess: ffmpegProc };
    // Optionnel : configuration d'une socket pour surveiller le RTCP, si nécessaire
    // activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
    // activeSession.socket.bind(sessionInfo.videoReturnPort);

    this.ongoingSessions.set(request.sessionID, activeSession);
    this.pendingSessions.delete(request.sessionID);

    // Signaler à HomeKit que le flux est lancé
    callback();
  }

  // Méthode pour arrêter le flux
  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      if (session.mainProcess) {
        this.log.info(`[${this.cameraName}] Arrêt du process FFmpeg pour sessionID = ${sessionID}`);
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