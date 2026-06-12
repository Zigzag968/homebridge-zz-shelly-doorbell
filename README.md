# Homebridge ZZ Shelly Doorbell

**Homebridge Plugin to Make Your Doorbell Smart:** This plugin connects a legacy wired doorbell or analog intercom system to Apple HomeKit using a Shelly Wi-Fi relay device and Homebridge. It lets you receive iOS notifications when someone presses your doorbell and (optionally) unlock your door via HomeKit. In essence, any old two-wire doorbell can become a smart doorbell with HomeKit integration.

## Project Overview

Most traditional doorbells and intercoms are not natively smart. **Homebridge ZZ Shelly Doorbell** bridges that gap by using a Shelly 1/1 Plus relay to detect doorbell presses and control the doorbell circuit. When the doorbell button is pressed, the Shelly’s input triggers this plugin to notify HomeKit – allowing you to get **push notifications on your iPhone** whether you’re home or away. The plugin also exposes controls in HomeKit to toggle your **physical chime or door strike**. For example, you can silence the mechanical chime at night or remotely buzz open the door through the Home app. This setup works entirely locally on your network and does not require any cloud services.

## Features

- **Doorbell Ring Notifications**
- **Mechanical Chime Control**
- **Remote Door Unlock (Intercom Mode)**
- **Multiple Doorbells Supported**
- **Customizable Names**
- **Local Webhook Integration**

## Installation

**Prerequisites:** Homebridge server (v1.8+), Node.js 16 or 18, Shelly device wired to your doorbell.

### Via Homebridge UI
Search for **“ZZ Shelly Doorbell”** and install directly.

### Via Terminal
```bash
sudo npm install -g homebridge-zz-shelly-doorbell
```

## Configuration

**Recommended form — `devices[]`** (one entry per doorbell, scales to several):
```json
{
  "platforms": [
    {
      "platform": "ShellyDoorbell",
      "name": "Doorbell",
      "port": 8081,
      "devices": [
        {
          "name": "Front door",
          "host": "192.168.1.23",
          "streamUrl": "rtsp://user:pass@192.168.1.41:554/...",
          "crop": { "x": 0, "y": 12, "width": 100, "height": 75 },
          "maxStreams": 4
        }
      ]
    }
  ]
}
```

Each entry has its own `host` (the Shelly's IP), optional `streamUrl`, `crop` and `maxStreams`. Add more objects to `devices[]` for additional doorbells. `port` is the shared webhook server port (platform-level).

> **Legacy "mono" form (deprecated):** older configs place the device fields (`host`, `streamUrl`, …) directly at the platform root, without a `devices` array. It still works (you'll get a deprecation warning in the log), and migrating to `devices[]` is **safe — it does not re-pair your accessory**: the HomeKit identity is derived from `host`, not from the config shape.

## Requirements

- Shelly 1 or Shelly 1 Plus
- 12V DC Power Supply
- Compatible doorbell wiring
- Static IP for both Shelly and Homebridge recommended

## Usage Notes

- Plugin auto-configures Shelly webhook
- Control physical chime or unlock via Home app
- Use Home app to manage notifications
- Ensure Shelly’s reset via switch is disabled

## Fake camera fallback

If you want to validate the HomeKit camera pipeline without wiring a real IP camera, you can enable a built-in demo stream. When `streamUrl` is **not** set on a doorbell, the plugin will fall back to a bundled looping MP4 (day / night variants, switched based on Berlin sunrise/sunset). This is purely a demo aid — it lets HomeKit treat the accessory as a camera and surface the rich doorbell notification UI with a live preview tile.

Enable it with the `useFakeStreamWhenNoUrl` toggle:

```json
{
  "platforms": [
    {
      "platform": "ShellyDoorbell",
      "name": "Doorbell",
      "host": "192.168.1.23",
      "port": 8081,
      "useFakeStreamWhenNoUrl": true
    }
  ]
}
```

The toggle defaults to `false`, so existing setups are unaffected. As soon as you provide a real `streamUrl`, that stream takes precedence and the fallback is ignored.

## Camera crop & multiple streams

When a real `streamUrl` is set, two extra options let you tailor the HomeKit camera:

```json
{
  "platform": "ShellyDoorbell",
  "name": "Doorbell",
  "host": "192.168.1.23",
  "streamUrl": "rtsp://user:pass@192.168.1.41:554/...",
  "maxStreams": 4,
  "crop": { "x": 33, "y": 13, "width": 55, "height": 75 }
}
```

### `crop` — region of interest (in %)

Keep only part of the feed (e.g. just the doorway). Values are **percentages (0–100)** of the source image, so the same config works at any resolution:

- `x` / `y` — offset of the box's top-left corner, from the left / top edge.
- `width` / `height` — size of the box.

The crop is applied to both the live stream and snapshots. Dimensions are rounded to even numbers (required by H.264); a box that falls outside the image is clamped, and invalid values are ignored (the full frame is used). Omit `crop` to disable it.

### `maxStreams` — simultaneous live viewers

HomeKit allows only **1** concurrent live stream by default. Set `maxStreams` (1–4, default 3) to allow several viewers at once — e.g. two Apple TVs plus an iPhone and an iPad. Each live stream is a separate FFmpeg transcode, so mind the host CPU and your camera's max RTSP client count; using the camera's **substream** keeps the load low. Notification snapshots are computed once and shared, so they don't count against this limit.

The live encoder is tuned for **low latency** (no input buffering, `ultrafast`/`zerolatency`, no B-frames), so the picture stays near real-time.

## License and Credits

Licensed under the **Apache-2.0 License**.

Developed by **Alexandre Guibert (Zigzag968)**.
