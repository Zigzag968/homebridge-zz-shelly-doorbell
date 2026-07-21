/**
 * Anti-rebond pour les évènements `event=doorbell` du webhook Shelly.
 *
 * Le webhook Shelly n'envoie qu'un GET ponctuel sur le front montant de l'input
 * (pas d'évènement "relâché", pas d'état continu accessible via ce plugin, qui est
 * un pur récepteur HTTP sans accès MQTT/RPC). On ne peut donc pas mesurer la durée
 * réelle de l'appui pour distinguer un vrai appui d'un ghost voltage transitoire sur
 * le câblage partagé — la seule défense disponible à cette couche est un cooldown :
 * ignorer un nouveau ring si le précédent date de moins de `minIntervalMs`.
 */
export class DoorbellDebounce {
  private lastTriggerAt = -Infinity;

  constructor(private readonly minIntervalMs: number) {}

  /**
   * Retourne `true` si ce ring doit déclencher HomeKit, `false` s'il doit être filtré.
   * Met à jour l'horodatage du dernier ring accepté uniquement quand il est accepté.
   */
  shouldTrigger(now: number = Date.now()): boolean {
    if (this.minIntervalMs > 0 && now - this.lastTriggerAt < this.minIntervalMs) {
      return false;
    }
    this.lastTriggerAt = now;
    return true;
  }
}
