export const PLUGIN_NAME = 'homebridge-zz-shelly-doorbell';
export const PLATFORM_NAME = 'ShellyDoorbell';
export const DEFAULT_PORT = 8081;
// Cooldown par défaut entre deux rings acceptés : protège des faux rings rapprochés
// (ghost voltage / rebond) sur un webhook one-shot sans info de durée d'appui.
export const DEFAULT_DOORBELL_DEBOUNCE_MS = 2000;