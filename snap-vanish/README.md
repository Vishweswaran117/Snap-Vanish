# Snap Vanish

Snap your fingers on a Meet / Teams / Zoom (web) call: you turn to dust and blow away, the room behind you
stays, and your mic mutes. Snap again and you come back, mic unmuted.

## Install (3 steps)

1. Unzip this folder somewhere permanent (Chrome reads it from there).
2. Open a terminal in the folder and run the one-time download of the on-device models (about 250 MB, mostly the AI room-fill model):
   - Mac / Linux: `bash setup.sh`
   - Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File setup.ps1`
   - Add `--no-lama` (`-NoLama` on Windows) to skip the AI room fill and use a basic fill instead.
3. In Chrome open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, pick this folder.

Then open your call tab (reload it if it was already open) and allow the camera and mic.

## Use

- **Snap**: hold thumb and middle finger together in view of the camera, then snap. Hand tracking must see the pinch and release, and the mic must hear the click.
- **Snap now** button / shortcut (default Alt+Shift+S, change at `chrome://extensions/shortcuts`) does the same without a gesture.
- For the best empty room, let the camera see the wall behind you for a few seconds (lean aside once). The AI fills whatever it never saw.
- Settings: sensitivity (higher = easier to trigger), dust duration, dust direction, AI room fill on/off.

## How it works / limits

- Everything runs in your browser: MediaPipe (hands + person mask) and LaMa (room inpainting) from local files. No video is uploaded anywhere. The only network use is the setup download.
- The call gets a processed camera track. Muting is done by disabling the mic track, so the app's own mute icon will not change. Others just hear silence.
- Turning the switch on only affects cameras opened afterwards, so reload the call tab.
- If the mic cannot be analysed (browser blocked audio until you click the page), the gesture alone triggers it. Click anywhere on the page once to enable click confirmation.
- Needs Chrome 116+. AI room fill uses about 1 GB of RAM and takes a few seconds per refresh in the background.
