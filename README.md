# RingLeader

Offline game-day soundboard for iPhone/iPad. Big buttons play songs from a set start point or goal horns over a Bluetooth speaker, and a giant STOP button cuts the sound right away.

## Install on iPhone/iPad
1. Open the app's URL in **Safari** (this needs signal once, at home).
2. Tap Share → **Add to Home Screen**.
3. Open it **from the home-screen icon**. The home-screen app keeps its own storage, separate from Safari, so add your sounds from inside it.
4. Tap **Edit → + Add button**, pick an MP3 from Files, and set its start and end points.

After that it works with no signal at all.

## At the game
- Pair the speaker *before* opening the app, then tap **Tap to start**.
- iPhone: set Settings → Display → Auto-Lock to **Never** as a backup to the in-app keep-awake setting.
- If the speaker cuts off the first second of a sound, turn on **Settings → Keep Bluetooth speaker awake**.
- **STOP** = near-instant cut (80 ms fade, no pop). **FADE** = 2 s fade-out. Tapping a playing button also stops it.

## Sharing with other parents
Settings → **Export board** creates one `.rlb` file with all buttons and sounds. AirDrop it, then the other person goes to Settings → **Import board**. Importing replaces their board.

**Keep the latest export in iCloud Drive as your backup.** iOS can clear web-app storage.

## Dev
No build step. Serve the folder over HTTPS (GitHub Pages). Bump `VERSION` in `sw.js` on every release, or phones keep the old cached code.

Music files never go in this repo; they live only on the devices.
