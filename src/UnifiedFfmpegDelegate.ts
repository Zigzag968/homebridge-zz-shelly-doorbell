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


interface SessionInfo {
  address: string // address of the HAP controller
  ipv6: boolean
  sessionID: string
  videoPort: number
  videoReturnPort: number
  videoSRTP: Buffer // key and salt concatenated
  videoSSRC: number // rtp synchronisation source
  audioPort: number
  audioReturnPort: number
  audioSRTP: Buffer
  audioSSRC: number
}

interface ActiveSession {
  socket?: Socket;
  mainProcess?: any; // FfmpegProcess ou spawn('ffmpeg', ...)
  returnProcess?: any; // si vous avez un second process pour le retour audio
  timeout?: NodeJS.Timeout;
}

export class UnifiedFfmpegDelegate implements CameraStreamingDelegate {

  // Dans le vrai code, ces maps contiennent les sessions en cours
  private pendingSessions: Map<string, SessionInfo> = new Map();
  private ongoingSessions: Map<string, ActiveSession> = new Map();

  constructor(
    private readonly log: Logger,
    private readonly videoConfig: any,  // vous pouvez typifier selon vos besoins
    private readonly cameraName: string,
    private readonly hap: HAP,
  ) {
    this.hap = hap;
  }

  /**
   * Méthode commune qui lance un job FFmpeg : soit un snapshot (isSnapshot = true), soit un flux vidéo continu.
   * - Pour un snapshot : on capture 1 image en MJPEG et on renvoie le Buffer
   * - Pour un flux : on transmet en RTP(SRT), selon les infos du sessionInfo
   */
  private startFfmpegJob(
    sessionInfo: SessionInfo,
    isSnapshot: boolean,
    request: StartStreamRequest | undefined,
    callback: StreamRequestCallback
  ) {
    // --- Construction de la ligne de commande FFmpeg ---

    // On part d'une source ; par ex. 'color=c=red:s=640x480:d=1' pour tester un flux rouge
    // ou du code similaire à votre "this.videoConfig.source"
    let ffmpegArgs = '';

    if (isSnapshot) {
      // On veut juste 1 frame en MJPEG
      // Exemple minimal :
      ffmpegArgs = `-f lavfi -i color=c=red:s=640x480:d=1 -frames:v 1 -f mjpeg -hide_banner -loglevel error -`;
    } else {
      // C'est un flux vidéo : on reprend la logique de votre code pour dimension, bitrate, etc.
      // On suppose que request n'est pas undefined ici.
      const mtu = this.videoConfig.packetSize || 1316;
      // Récupération d'infos ex. FPS/bitrate
      const fps = request!.video.fps;
      const videoBitrate = request!.video.max_bit_rate;
      // Construction simplifiée (vous pouvez copier la logique de vcodec, mapvideo, ssrc, etc.)
      ffmpegArgs = this.videoConfig.source!;  // ex. '-re -i ...'
      // Ajout d'options vidéo
      ffmpegArgs += ` -an -sn -dn`;  // pas d'audio, sous-titre, data
      ffmpegArgs += ` -codec:v libx264 -pix_fmt yuv420p -r ${fps} -b:v ${videoBitrate}k`;
      ffmpegArgs += ` -f rawvideo`;
      // Paramètres RTP
      //ffmpegArgs += ` -ssrc ${sessionInfo.videoSSRC} -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80`;
      ffmpegArgs += ` -srtp_out_params ${sessionInfo.videoSRTP.toString('base64')}`;
      ffmpegArgs += ` srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`;
      ffmpegArgs += ` -loglevel level+verbose`;
    }

    this.log.info(`Lancement FFmpeg [${isSnapshot ? 'SNAPSHOT' : 'STREAM'}]: ffmpeg ${ffmpegArgs}`);

    // --- Lancement du processus FFmpeg ---

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs.split(' '), { env: process.env });
    let snapshotBuffer = Buffer.alloc(0);

    // Si c'est un snapshot, on recueille la sortie sur stdout
    if (isSnapshot) {
      ffmpegProcess.stdout.on('data', (data) => {
        snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
      });
    }

    ffmpegProcess.stderr.on('data', (data) => {
      if (this.videoConfig.debug) {
        this.log.debug(`FFmpeg stderr: ${data.toString()}`);
      }
    });

    ffmpegProcess.on('error', (error: Error) => {
      this.log.error(`FFmpeg process creation failed: ${error.message}`);
      callback(error);
    });

    ffmpegProcess.on('close', () => {
      this.log.info(`FFmpeg [${isSnapshot ? 'SNAPSHOT' : 'STREAM'}] terminé`);
      if (isSnapshot) {
        if (snapshotBuffer.length > 0) {
          callback(undefined);
        } else {
          callback(new Error('Snapshot buffer vide.'));
        }
      } else {
        // Pour un flux, on ne renvoie pas de Buffer à HomeKit ; on signale juste que c'est ok
        // callback() doit être appelé dans startStream si tout se passe bien
      }
    });

    return ffmpegProcess;
  }

  // ---------------------------------------------------
  // Méthodes standard du CameraStreamingDelegate
  // ---------------------------------------------------

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    this.log.info(`[${this.cameraName}] prepareStream: sessionID = ${request.sessionID}`);

    const options = {
      type: "udp" as Type,
      ip: request.addressVersion === 'ipv6' ? '::' : '0.0.0.0',
      reserveTimeout: 15,
    }
    const videoReturnPort = await pickPort(options);
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await pickPort(options);
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    // Création d'un SessionInfo
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

    // Stockage de la session dans pendingSessions
    this.pendingSessions.set(request.sessionID, sessionInfo);

    // Réponse à HomeKit : on renvoie la configuration qu'on "accepte" (ex. : video & audio)
    // La plus grande partie des infos se trouve déjà dans 'request',
    // mais vous pouvez ajouter ou modifier des champs si nécessaire.
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

    this.log.info(`[${this.cameraName}] prepareStream: renvoi de la réponse à HomeKit`);
    callback(undefined, response);
  }

  /**
   * 1) handleSnapshotRequest : on récupère ou génère 1 frame
   */
  handleSnapshotRequest(request: any, callback: (error: Error | undefined, snapshot?: Buffer) => void): void {
    this.log.info(`[${this.cameraName}] handleSnapshotRequest : on va lancer FFmpeg en mode snapshot`);
    // On va créer un "fake" sessionInfo ou minimal
    const snapshotSession: SessionInfo = {
      sessionID: 'snapshotSession',
      address: '127.0.0.1',
      ipv6: false,
      videoPort: 0,
      videoReturnPort: 0,
      videoSRTP: Buffer.alloc(0),
      videoSSRC: 12345,
      audioPort: 0,
      audioReturnPort: 0,
      audioSRTP: Buffer.alloc(0),
      audioSSRC: 0
    };
    // On appelle la méthode commune en mode snapshot (isSnapshot = true)
    // Le callback doit être de type StreamRequestCallback => on va adapter
    // Pour un snapshot, c'est un callback(Error|null, Buffer?)
    this.startFfmpegJob(snapshotSession, true, undefined, (err: Error | undefined, data?: Buffer) => {
      if (err) {
      callback(err);
      } else {
      // data est un Buffer (noté "snapshot" dans l'interface)
      callback(undefined, data);
      }
    });
  }

  /**
   * 2) handleStreamRequest : démarre / arrête / reconfigure un flux vidéo
   */
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request as StartStreamRequest, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.info(`Reconfigure request ignorée pour l’instant.`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    // On récupère sessionInfo depuis pendingSessions (dans votre code complet)
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      this.log.error(`Impossible de trouver la session ${request.sessionID}`);
      callback(new Error('Session introuvable'));
      return;
    }

    this.log.info(`[${this.cameraName}] startStream : on va lancer FFmpeg en mode flux`);
    // Lancement du job FFmpeg en mode flux (isSnapshot = false)
    const ffmpegProc = this.startFfmpegJob(sessionInfo, false, request, (err: Error | undefined, _data?: Buffer) => {
      if (err) {
        this.log.error(`Erreur lors du lancement du flux : ${err.message}`);
        callback(err);
      } else {
        this.log.info(`Flux démarré avec succès (sessionID = ${request.sessionID}).`);
        callback(); // signale à HomeKit que le flux est lancé
      }
    });

    // Exemple minimal de gestion de socket pour RTCP
    const activeSession: ActiveSession = {};
    activeSession.mainProcess = ffmpegProc;
    activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
  //  activeSession.socket.bind(sessionInfo.videoReturnPort);
    this.ongoingSessions.set(request.sessionID, activeSession);

    this.pendingSessions.delete(request.sessionID);
  }

  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      if (session.mainProcess) {
        this.log.info(`Arrêt du process FFmpeg pour sessionID = ${sessionID}`);
        try {
          session.mainProcess.kill('SIGKILL');
        } catch (err) {
          this.log.error(`Erreur en killant FFmpeg : ${err}`);
        }
      }
      if (session.socket) {
        session.socket.close();
      }
      this.ongoingSessions.delete(sessionID);
    }
  }
}