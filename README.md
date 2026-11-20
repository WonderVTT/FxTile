# FXMaster Tile Effects (Foundry VTT v12)

Fills a Tile with an FXMaster particle effect (fog, clouds, snow, embers...).
The effect is drawn **at the Tile's elevation and sort**, so it slots in between
your other tiles. Stack several effect tiles at different elevations to get
independent layers (e.g. 4 fog layers in a rift, each with its own speed and scale).

Requires **FXMaster 7.3.0 or newer (7.x line)** on **Foundry v12**.

## Install
1. Unzip so you get `Data/modules/fxmaster-tile-fx/module.json`.
2. Restart Foundry (or return to Setup), enable **FXMaster Tile Effects** in your world.

## Use
1. Create a Tile covering the area (any image or none; the effect replaces it).
2. Open the Tile config → **FX** tab.
3. Tick **Fill this Tile with an FXMaster effect**, pick the effect, set parameters, Save.
   Changes preview live while the config is open (closing without saving reverts them).
4. Set the Tile's **Elevation** (and Sort) to place the layer between your other tiles.

The effect fills the Tile's rectangle with a hard edge and follows the Tile's
position, rotation, opacity, hidden state and elevation.

### Rift example (4 fog layers)
| Tile elevation | Scale | Speed | Density | Opacity | Tint |
|---|---|---|---|---|---|
| 5  (deepest) | 0.5 | 0.3 | 0.10 | 1.0 | dark purple, apply |
| 15 | 0.8 | 0.5 | 0.08 | 0.8 | lighter purple, apply |
| 25 | 1.2 | 0.8 | 0.06 | 0.6 | none |
| 35 (top) | 1.8 | 1.2 | 0.04 | 0.4 | none |

Fog drifts in random directions. If you want layers sliding in clearly different
directions, use **Clouds** for some layers: it has a Direction parameter.

## Notes
- Only the GM sees the FX tab. Everyone sees the effect (hidden tiles: GM only).
- FXMaster's global "disable" settings also turn these effects off.
- Occlusion: the effect follows the Tile's **Fade** occlusion and hover fade (whole-layer alpha).
  **Radial** and **Vision** occlusion cut a hole per pixel in core's tile shader; the effect does not
  copy that hole and only fades as a whole when the tile falls back to fade.
- Macro helpers: `game.modules.get("fxmaster-tile-fx").api.rebuildAll()`.
