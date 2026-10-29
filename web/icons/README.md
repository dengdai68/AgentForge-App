# Application icon

`application.png` is the unmodified 1254×1254 PNG supplied by the project owner (SHA-256 `35d0d4489508658eb2ba854fdecdb4d5c2f60240c5ce7b5569e20044add0eaf3`). It is the sole source of the blue/purple ribbon A mark. Generate `apps/electron/application.icns` with macOS sips/iconutil:

```sh
node scripts/build-app-icon.cjs
```

The sidebar and Dock use this exact PNG; the packaged application uses its generated ICNS. The menu-bar template uses the PNG's alpha silhouette. Generation only scales native sizes, never redraws or overwrites the PNG, and requires no browser or network. Commit the PNG and regenerated ICNS together when changing the mark. The obsolete three-bar SVG has been removed so it cannot overwrite the supplied image.

The `vscode/` subset has its own source and license.
