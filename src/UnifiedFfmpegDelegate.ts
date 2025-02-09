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

//
// Delegate utilisant FFmpeg pour générer un snapshot et un flux vidéo continu
//
export class UnifiedFfmpegDelegate implements CameraStreamingDelegate {
  // Maps pour gérer les sessions en attente et actives.
  private pendingSessions: Map<string, SessionInfo> = new Map();
  private ongoingSessions: Map<string, ActiveSession> = new Map();

  constructor(
    private readonly log: Logger,
    private readonly source: string[],   // Par exemple, "-i /chemin/vers/fakeStreetImage.jpg"
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
    const ffmpegArgs = `${this.source} -frames:v 1 -vsync 0 -f mjpeg -hide_banner -loglevel error -`;
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
    const fps = request.video.fps;
    const videoBitrate = request.video.max_bit_rate;
 
    const videoConfig = {
      mapvideo: null,
      encoderOptions: "",
      resolution: {
        width: request.video.width,
        height: request.video.height,
        videoFilter: ""
      }
    };
    
  let ffmpegArgsArray = [
    ...this.source,
    videoConfig.mapvideo ? `-map ${videoConfig.mapvideo}` : '-an -sn -dn',
    '-codec:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'mpeg',
    ...(fps > 0 ? ['-r', `${fps}`] : []),
    '-f', 'rawvideo',
    ...(videoConfig.encoderOptions ? videoConfig.encoderOptions.split(' ') : []),
    ...(videoConfig.resolution.videoFilter ? ['-filter:v', videoConfig.resolution.videoFilter] : []),
    ...(videoBitrate > 0 ? ['-b:v', `${videoBitrate}k`] : []),
    '-payload_type', `${request.video.pt}`,
    '-ssrc', `${sessionInfo.videoSSRC}`,
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', `${sessionInfo.videoSRTP.toString('base64')}`,
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
  
    // Création de la session active pour le flux
    const activeSession: ActiveSession = { mainProcess: ffmpegProc };
    // Optionnel : si nécessaire, vous pouvez créer et binder une socket pour RTCP
    // activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
    // activeSession.socket.bind(sessionInfo.videoReturnPort);
  
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