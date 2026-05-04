# lightSystem

Node-based dashboard for controlling Hue and Govee lights from a local web UI.

## Run from source

```powershell
npm install
node setup.js
npm start
```

Open `http://localhost:3000` after the server starts.

## Build a Windows executable

```powershell
npm install
npm run build:exe
```

The packaged app is written to `dist/lightsystem.exe`.

## Notes

- Keep `config.json` set up before building so the packaged app has the same controller configuration.
- The executable listens on port `3000`.
