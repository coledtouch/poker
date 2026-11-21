# Sunrise Compass

A PWA you hold up in front of you and turn around: it overlays the sun's path for your exact GPS location on your camera view, shows where the sun rises and sets, and tells you what time the sun shines from whatever direction you point.

Live: https://sunrise-compass.coleciprari.workers.dev

## Features
- **Sky (AR) view**: camera feed with horizon, compass ticks, today's sun arc with hour markers, golden-hour section, sunrise/sunset pins, and arrows to off-screen targets.
- **Crosshair readout**: "The sun will be right here at 10:40 AM", or when the sun passes the compass bearing you're facing.
- **Map view**: a top-down dial that rotates with you, showing sunrise/sunset bearings and the sun's path.
- **Time & date scrubber**: check any time today, or step to other days (seasonal changes).
- Works offline once loaded; install from the browser ("Add to Home Screen").
- No compass (desktop)? Drag to look around.

## Develop / deploy
Plain HTML/JS in `public/`. `build.mjs` bundles it into a single Cloudflare Worker (`dist/worker.js`).

```sh
npm install
npm run dev      # local
npm run deploy   # needs CLOUDFLARE_API_TOKEN (Workers edit) and CLOUDFLARE_ACCOUNT_ID
```

Solar math adapted from [SunCalc](https://github.com/mourner/suncalc) (BSD-2-Clause).
