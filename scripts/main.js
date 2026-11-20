/**
 * FXMaster Tile Effects (Foundry VTT v12)
 *
 * Fills a Tile's rectangle with an FXMaster particle effect. The effect is a
 * PrimaryCanvasObject added to canvas.primary with the Tile's elevation, sort
 * layer and sort, so Foundry sorts it together with tiles: it draws just above
 * its own Tile and below anything higher. Several effect tiles at different
 * elevations give independent, stacked layers.
 *
 * Data lives on the Tile document:
 *   flags["fxmaster-tile-fx"] = {
 *     enabled: boolean,
 *     type: string,            // key of CONFIG.fxmaster.particleEffects, e.g. "fog"
 *     hideImage: boolean,      // hide the Tile's own image/video
 *     options: { [param]: value } // same shape FXMaster stores in scene flags
 *   }
 */

const MODULE_ID = "fxmaster-tile-fx";
const TAB_ID = "fxtile";

/** Parameters that make no sense for a tile-bound effect. */
const SKIP_PARAMS = new Set(["belowTokens", "soundFxEnabled"]);

/** Extra spawn area around the tile (fraction of the shorter side) so edges stay as dense as the middle. */
const SPAWN_MARGIN = 0.15;

/** tileId -> { container, fx } */
const active = new Map();

/** tileId -> signature of the last build that produced no effect, so refreshes don't retry it forever. */
const lastAttempt = new Map();

/** Tiles whose mesh we hid, so we can restore them. */
const hiddenMeshes = new WeakSet();

let TileFXContainer = null;
let warnedOldFXMaster = false;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function fxmasterReady() {
  if (!game.modules.get("fxmaster")?.active) return false;
  if (!CONFIG.fxmaster?.particleEffects) return false;
  try {
    if (game.settings.get("fxmaster", "enable") === false) return false;
    if (game.settings.get("fxmaster", "disableAll") === true) return false;
  } catch {
    /* settings may not exist in some versions */
  }
  return true;
}

function getConfig(tileDoc) {
  return tileDoc?.flags?.[MODULE_ID] ?? null;
}

function isEnabledFor(tileDoc) {
  const cfg = getConfig(tileDoc);
  return !!(cfg?.enabled && cfg?.type && CONFIG.fxmaster?.particleEffects?.[cfg.type]);
}

function getContainerClass() {
  if (TileFXContainer) return TileFXContainer;
  const Mixin = foundry.canvas?.primary?.PrimaryCanvasObjectMixin ?? globalThis.PrimaryCanvasObjectMixin;
  if (!Mixin) throw new Error(`${MODULE_ID} | PrimaryCanvasObjectMixin not found (is this Foundry v12?)`);

  TileFXContainer = class TileFXContainer extends Mixin(PIXI.Container) {
    constructor(tile) {
      super();
      this.fxTile = tile; // not `object`, so core never mistakes this for the tile mesh
      this.cullable = false;
      this.eventMode = "none";
      this.sortableChildren = false;
    }
  };
  return TileFXContainer;
}

/**
 * Turn stored values into FXMaster's `{ key: { value } }` option shape.
 * Only keys the effect declares are passed: switching type in the config merges
 * the old type's keys into the flags, and those must not leak into the new effect.
 */
function buildEffectOptions(cfg, EffectClass) {
  const known = EffectClass?.parameters ?? {};
  const out = {};
  for (const [k, v] of Object.entries(cfg.options ?? {})) {
    if (SKIP_PARAMS.has(k) || !(k in known)) continue;
    out[k] = { value: v };
  }
  return out;
}

/**
 * Everything that requires rebuilding the effect when it changes. TileConfig's
 * live preview merges form values straight into the document and calls
 * refresh(), so comparing this on refreshTile gives a live preview for free.
 */
function effectSignature(tile) {
  const doc = tile.document;
  if (!isEnabledFor(doc)) return null;
  const cfg = getConfig(doc);
  return JSON.stringify([cfg.type, cfg.options ?? {}, Math.abs(Number(doc.width) || 0), Math.abs(Number(doc.height) || 0)]);
}

/** The context FXMaster (7.3+) uses instead of the scene dimensions: spawn inside the tile, in local space. */
function buildParticleContext(w, h) {
  const size = Number(canvas.dimensions?.size) || 100;
  const m = Math.round(Math.min(w, h) * SPAWN_MARGIN);
  const W = w + 2 * m;
  const H = h + 2 * m;
  return {
    dimensions: {
      width: W,
      height: H,
      size,
      sceneX: -m,
      sceneY: -m,
      sceneWidth: W,
      sceneHeight: H,
      sceneRect: new PIXI.Rectangle(-m, -m, W, H),
    },
    renderer: canvas.app?.renderer ?? null,
    ticker: canvas.app?.ticker ?? PIXI.Ticker.shared,
  };
}

/* -------------------------------------------- */
/*  Effect lifecycle                            */
/* -------------------------------------------- */

function destroyEffect(tileId) {
  const entry = active.get(tileId);
  if (!entry) return;
  active.delete(tileId);
  try {
    entry.fx?.stop?.();
  } catch (err) {
    console.debug(MODULE_ID, err);
  }
  try {
    entry.container.parent?.removeChild(entry.container);
  } catch (err) {
    console.debug(MODULE_ID, err);
  }
  try {
    entry.container.destroy({ children: true });
  } catch (err) {
    console.debug(MODULE_ID, err);
  }
}

function destroyAll() {
  for (const id of Array.from(active.keys())) destroyEffect(id);
  lastAttempt.clear();
  removeTicker();
}

function buildEffect(tile) {
  if (!tile || tile.isPreview || !tile.id) return;
  destroyEffect(tile.id);
  restoreMesh(tile);

  if (!fxmasterReady() || !canvas.primary) return;
  const doc = tile.document;
  if (!isEnabledFor(doc)) return;

  const cfg = getConfig(doc);
  const EffectClass = CONFIG.fxmaster.particleEffects[cfg.type];
  const w = Math.abs(Number(doc.width) || 0);
  const h = Math.abs(Number(doc.height) || 0);
  if (!w || !h) return;

  if (!CONFIG.fxmaster.getParticleContext && !warnedOldFXMaster) {
    warnedOldFXMaster = true;
    if (game.user.isGM) ui.notifications.warn(game.i18n.localize("FXTILE.OldFXMaster"));
  }

  const ctx = buildParticleContext(w, h);
  const options = buildEffectOptions(cfg, EffectClass);
  options.__fxmParticleContext = ctx;

  let fx;
  try {
    fx = new EffectClass(options);
  } catch (err) {
    console.error(`${MODULE_ID} | Could not create "${cfg.type}" for tile ${tile.id}`, err);
    return;
  }
  fx.__fxmParticleContext = ctx;
  try {
    fx.blendMode = EffectClass.defaultConfig?.blendMode ?? PIXI.BLEND_MODES.NORMAL;
  } catch {
    /* ignore */
  }

  // Hard-edged mask covering exactly the tile.
  const mask = new PIXI.Graphics();
  mask.beginFill(0xffffff, 1).drawRect(0, 0, w, h).endFill();

  const Cls = getContainerClass();
  const container = new Cls(tile);
  container.addChild(fx);
  container.addChild(mask);
  container.mask = mask;

  active.set(tile.id, { container, fx, w, h, sig: effectSignature(tile), baseAlpha: 1 });
  syncEffect(tile);
  canvas.primary.addChild(container);
  ensureTicker();

  try {
    fx.play({ prewarm: true });
  } catch (err) {
    console.error(`${MODULE_ID} | Could not play "${cfg.type}" for tile ${tile.id}`, err);
  }
}

/** Keep position, rotation, sorting, visibility and alpha in step with the Tile. */
function syncEffect(tile) {
  if (!tile || tile.isPreview) return;
  const entry = active.get(tile.id);
  const doc = tile.document;
  const cfg = getConfig(doc);

  // Type, options or size changed (saved update or TileConfig live preview): rebuild.
  const sig = effectSignature(tile);
  const builtSig = entry ? entry.sig : lastAttempt.get(tile.id) ?? null;
  if (sig !== builtSig) {
    if (!sig) restoreMesh(tile);
    queueRebuild(tile.id);
    if (!entry) return;
  }

  // Hide or restore the tile's own image.
  if (entry && cfg?.hideImage !== false) hideMesh(tile);
  else restoreMesh(tile);

  if (!entry) return;
  const { container, w, h } = entry;

  container.pivot.set(w / 2, h / 2);
  container.position.set(doc.x + w / 2, doc.y + h / 2);
  container.angle = Number(doc.rotation) || 0;

  const SORT_LAYERS = (foundry.canvas?.groups?.PrimaryCanvasGroup ?? globalThis.PrimaryCanvasGroup)?.SORT_LAYERS;
  container.elevation = Number(doc.elevation) || 0;
  container.sortLayer = SORT_LAYERS?.TILES ?? 500;
  container.sort = Number(doc.sort) || 0;
  container.zIndex = (Number(tile.mesh?.zIndex) || 0) + 1;

  const meshVisible = tile.mesh ? tile.mesh.visible !== false : true;
  container.visible = !!tile.isVisible && meshVisible;

  // Same as core: mesh.alpha = tile.alpha * (hidden ? 0.5 : 1); doc.alpha is the unoccluded alpha.
  const tileAlpha = Number.isFinite(tile.alpha) ? tile.alpha : 1;
  entry.baseAlpha = tileAlpha * (doc.hidden ? 0.5 : 1);
  applyOcclusionAlpha(tile, entry);
}

/**
 * Follow the tile's fade occlusion (FADE mode, hover fade, VISION without vision).
 * Core updates mesh._occlusionState every frame even when the mesh isn't renderable.
 * RADIAL and VISION masking are per-pixel in the tile shader and are not replicated.
 */
function applyOcclusionAlpha(tile, entry) {
  const doc = tile.document;
  const mesh = tile.mesh;
  const unoccluded = Number.isFinite(doc.alpha) ? doc.alpha : 1;
  let a = unoccluded;
  const fade = mesh?._occlusionState?.fade;
  if (mesh && Number.isFinite(fade) && fade > 0) {
    const occluded = Number.isFinite(mesh.occludedAlpha) ? mesh.occludedAlpha : unoccluded;
    a = unoccluded + (occluded - unoccluded) * fade;
  }
  const alpha = entry.baseAlpha * a;
  if (entry.container.alpha !== alpha) entry.container.alpha = alpha;
}

let tickerFn = null;
function ensureTicker() {
  if (tickerFn || !canvas.app?.ticker) return;
  tickerFn = () => {
    for (const [id, entry] of active) {
      const tile = canvas.tiles?.get(id);
      if (tile && !entry.container.destroyed) applyOcclusionAlpha(tile, entry);
    }
  };
  canvas.app.ticker.add(tickerFn, null, PIXI.UPDATE_PRIORITY.LOW);
}

function removeTicker() {
  if (!tickerFn) return;
  canvas.app?.ticker?.remove(tickerFn);
  tickerFn = null;
}

function hideMesh(tile) {
  if (!tile.mesh) return;
  tile.mesh.renderable = false;
  hiddenMeshes.add(tile);
}

function restoreMesh(tile) {
  if (!tile?.mesh || !hiddenMeshes.has(tile)) return;
  tile.mesh.renderable = true;
  hiddenMeshes.delete(tile);
}

const pendingRebuilds = new Set();
let rebuildScheduled = false;
function queueRebuild(tileId) {
  pendingRebuilds.add(tileId);
  if (rebuildScheduled) return;
  rebuildScheduled = true;
  requestAnimationFrame(() => {
    rebuildScheduled = false;
    const ids = Array.from(pendingRebuilds);
    pendingRebuilds.clear();
    for (const id of ids) {
      const tile = canvas.tiles?.get(id);
      if (!tile) {
        destroyEffect(id);
        lastAttempt.delete(id);
        continue;
      }
      buildEffect(tile);
      if (active.has(id)) lastAttempt.delete(id);
      else lastAttempt.set(id, effectSignature(tile));
    }
  });
}

function rebuildAll() {
  destroyAll();
  for (const tile of canvas.tiles?.placeables ?? []) {
    if (isEnabledFor(tile.document)) buildEffect(tile);
  }
}

/* -------------------------------------------- */
/*  Canvas hooks                                */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  if (!game.modules.get("fxmaster")?.active && game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("FXTILE.NoFXMaster"));
  }
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { rebuildAll, rebuild: (tileId) => queueRebuild(tileId) };
});

Hooks.on("canvasReady", () => rebuildAll());
Hooks.on("canvasTearDown", () => destroyAll());

Hooks.on("drawTile", (tile) => {
  if (!canvas.ready || tile.isPreview) return;
  if (isEnabledFor(tile.document)) queueRebuild(tile.id);
});

Hooks.on("refreshTile", (tile) => syncEffect(tile));

Hooks.on("destroyTile", (tile) => {
  if (tile.isPreview) return;
  destroyEffect(tile.id);
});

// Flag-only updates don't always refresh the Tile, so sync here too. syncEffect only
// rebuilds when the signature changed, so a save after a live preview keeps the particles running.
Hooks.on("updateTile", (doc, changes) => {
  if (!canvas.ready || doc.parent !== canvas.scene) return;
  const flagsChanged =
    foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) || `-=${MODULE_ID}` in (changes.flags ?? {});
  if (flagsChanged && doc.object) syncEffect(doc.object);
});

Hooks.on("deleteTile", (doc) => {
  destroyEffect(doc.id);
  lastAttempt.delete(doc.id);
});

/* -------------------------------------------- */
/*  Tile Config tab                             */
/* -------------------------------------------- */

function esc(s) {
  return foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s)) : String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loc(key) {
  return game.i18n.localize(key);
}

function effectChoices() {
  const entries = Object.entries(CONFIG.fxmaster?.particleEffects ?? {}).filter(([, cls]) => !cls.hidden);
  const groupOrder = ["weather", "ambient", "animals", "other"];
  entries.sort(([, a], [, b]) => {
    const ga = groupOrder.indexOf(a.group);
    const gb = groupOrder.indexOf(b.group);
    if (ga !== gb) return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
    return loc(a.label).localeCompare(loc(b.label));
  });
  return entries;
}

function roundTo(v, decimals) {
  const f = 10 ** (decimals ?? 2);
  return Math.round(v * f) / f;
}

/** Render the parameter controls for one effect class. */
function renderParams(EffectClass, saved) {
  const params = EffectClass?.parameters ?? {};
  const base = `flags.${MODULE_ID}.options`;
  const rows = [];

  for (const [key, def] of Object.entries(params)) {
    if (SKIP_PARAMS.has(key)) continue;
    const name = `${base}.${key}`;
    const label = esc(loc(def.label ?? key));
    const value = saved && key in saved ? saved[key] : def.value;

    switch (def.type) {
      case "range": {
        const min = def.min ?? 0;
        const max = def.max ?? 1;
        const step = def.step ?? 0.1;
        let v = Number(value);
        if (!Number.isFinite(v)) v = def.value ?? min;
        v = Math.min(max, Math.max(min, v));
        rows.push(`
          <div class="form-group">
            <label>${label}</label>
            <div class="form-fields fxtile-range">
              <input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${v}" data-dtype="Number" data-decimals="${def.decimals ?? 2}">
              <span class="fxtile-range-value">${roundTo(v, def.decimals)}</span>
            </div>
          </div>`);
        break;
      }
      case "checkbox": {
        rows.push(`
          <div class="form-group">
            <label>${label}</label>
            <div class="form-fields">
              <input type="checkbox" name="${name}" data-dtype="Boolean" ${value ? "checked" : ""}>
            </div>
          </div>`);
        break;
      }
      case "color": {
        const color = value?.value ?? def.value?.value ?? "#ffffff";
        const apply = value?.apply ?? def.value?.apply ?? false;
        rows.push(`
          <div class="form-group">
            <label>${label}</label>
            <div class="form-fields fxtile-color">
              <input type="color" name="${name}.value" value="${esc(color)}">
              <label class="checkbox">${esc(loc("FXTILE.Apply"))}
                <input type="checkbox" name="${name}.apply" data-dtype="Boolean" ${apply ? "checked" : ""}>
              </label>
            </div>
          </div>`);
        break;
      }
      case "select":
      case "multi-select": {
        const multiple = def.type === "multi-select";
        const selected = new Set(Array.isArray(value) ? value : [value]);
        const opts = Object.entries(def.options ?? {})
          .map(([k, l]) => `<option value="${esc(k)}" ${selected.has(k) ? "selected" : ""}>${esc(loc(l))}</option>`)
          .join("");
        rows.push(`
          <div class="form-group">
            <label>${label}</label>
            <div class="form-fields">
              <select name="${name}" ${multiple ? "multiple" : ""}>${opts}</select>
            </div>
          </div>`);
        break;
      }
      default:
        break;
    }
  }
  return rows.join("");
}

function wireParamInputs(container) {
  for (const input of container.querySelectorAll(".fxtile-range input[type=range]")) {
    const out = input.parentElement.querySelector(".fxtile-range-value");
    input.addEventListener("input", () => {
      out.textContent = roundTo(Number(input.value), Number(input.dataset.decimals));
    });
  }
}

Hooks.on("renderTileConfig", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const form = root.tagName === "FORM" ? root : root.querySelector("form");
  if (!form || form.querySelector(`.tab[data-tab="${TAB_ID}"]`)) return;

  const doc = app.document ?? app.object;
  const cfg = getConfig(doc) ?? {};
  const fxReady = !!CONFIG.fxmaster?.particleEffects;

  const choices = fxReady ? effectChoices() : [];
  const currentType = cfg.type && CONFIG.fxmaster?.particleEffects?.[cfg.type] ? cfg.type : choices.find(([k]) => k === "fog")?.[0] ?? choices[0]?.[0];
  const savedFor = (type) => (type === cfg.type ? cfg.options ?? {} : null);

  const typeOptions = choices
    .map(([k, cls]) => `<option value="${esc(k)}" ${k === currentType ? "selected" : ""}>${esc(loc(cls.label))}</option>`)
    .join("");

  // Tab content. Other modules nest sub-tabs inside their own tab (Monk's Active Tiles puts
  // trigger-setup/actions/images inside "triggers"), so only look at top-level tabs: siblings
  // of the first tab found in the form.
  const existingTab = form.querySelector(".tab[data-tab]");
  const tabParent = existingTab?.parentElement ?? null;
  const topTabs = tabParent ? Array.from(tabParent.children).filter((el) => el.matches(".tab[data-tab]")) : [];
  const group = existingTab?.dataset.group;

  const tab = document.createElement("div");
  tab.className = "tab fxtile-tab";
  tab.dataset.tab = TAB_ID;
  if (group) tab.dataset.group = group;
  tab.innerHTML = fxReady
    ? `
      <p class="notes">${esc(loc("FXTILE.Hint"))}</p>
      <div class="form-group">
        <label>${esc(loc("FXTILE.Enabled"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.${MODULE_ID}.enabled" data-dtype="Boolean" ${cfg.enabled ? "checked" : ""}>
        </div>
      </div>
      <div class="form-group">
        <label>${esc(loc("FXTILE.Effect"))}</label>
        <div class="form-fields">
          <select name="flags.${MODULE_ID}.type" class="fxtile-type">${typeOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label>${esc(loc("FXTILE.HideImage"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.${MODULE_ID}.hideImage" data-dtype="Boolean" ${cfg.hideImage !== false ? "checked" : ""}>
        </div>
        <p class="hint">${esc(loc("FXTILE.HideImageHint"))}</p>
      </div>
      <fieldset>
        <legend>${esc(loc("FXTILE.Parameters"))}</legend>
        <div class="fxtile-params">${renderParams(CONFIG.fxmaster.particleEffects[currentType], savedFor(currentType))}</div>
      </fieldset>`
    : `<p class="notes">${esc(loc("FXTILE.NoFXMaster"))}</p>`;

  const lastTab = topTabs[topTabs.length - 1];
  if (lastTab) lastTab.after(tab);
  else {
    const footer = form.querySelector("footer, button[type=submit]");
    footer ? footer.before(tab) : form.append(tab);
  }

  // Nav item: the nav that lists the top-level tabs, not a module's nested sub-nav.
  const firstTabName = existingTab?.dataset.tab;
  const navs = Array.from(root.querySelectorAll("nav.tabs, nav.sheet-tabs, .tabs"));
  const nav =
    (firstTabName && navs.find((n) => n.querySelector(`[data-tab="${CSS.escape(firstTabName)}"]`))) || navs[0] || null;
  if (nav && !nav.querySelector(`[data-tab="${TAB_ID}"]`)) {
    const item = document.createElement("a");
    item.className = "item";
    item.dataset.tab = TAB_ID;
    if (group) item.dataset.group = group;
    item.innerHTML = `<i class="fas fa-hat-wizard"></i> ${esc(loc("FXTILE.Tab"))}`;
    nav.append(item);
  } else if (!nav) {
    // No tabs in this sheet: show the content directly.
    tab.classList.add("active");
  }

  // Wire up interactivity
  const paramsEl = tab.querySelector(".fxtile-params");
  if (paramsEl) wireParamInputs(paramsEl);
  tab.querySelector(".fxtile-type")?.addEventListener("change", (ev) => {
    const type = ev.currentTarget.value;
    paramsEl.innerHTML = renderParams(CONFIG.fxmaster.particleEffects[type], savedFor(type));
    wireParamInputs(paramsEl);
    app.setPosition({ height: "auto" });
  });

  // Re-activate our tab if it was the active one before a re-render.
  const tabs = app._tabs?.[0];
  if (tabs?.active === TAB_ID) tabs.activate(TAB_ID);

  app.setPosition({ height: "auto" });
});
