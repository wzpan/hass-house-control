// house-control-card: the House Control 3D home as a Home Assistant dashboard card.
//
// The 3D app runs unchanged in an iframe (embed.html, next to this file). This card is
// its "native shell": it hands it the plan, turns its commands into Home Assistant
// service calls with the dashboard's own login, and feeds it the live entity states.
//
//   type: custom:house-control-card
//   height: 640          # px, optional
//   plan: { ...House Control plan.json, with link: { service: homeassistant, id } ... }

const VERSION = '1.5.0';
// Where the 3D app (embed.html) lives. Next to this file by default; when this card is
// installed inline (a data: URL kept inside Home Assistant) the installer bakes it in.
const BAKED_APP_URL = '__HOUSE_APP_URL__';
const APP_URL = BAKED_APP_URL.startsWith('http') ? BAKED_APP_URL
  : import.meta.url.startsWith('http') ? new URL('./embed.html', import.meta.url).href : '';

// Only these fields of a command are ever turned into a service call.
const LIGHT_KEYS = ['on', 'brightness', 'temp', 'color'];
const AC_KEYS = ['on', 'mode', 'target', 'fan', 'swing', 'sleep', 'eco'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

/* ---------- Home Assistant <-> House Control mapping (port of HomeAssistantService.swift) ---------- */

const MODE_NAMES = [['cool', ['cool']], ['heat', ['heat']], ['dry', ['dry']], ['fan', ['fan_only']], ['auto', ['auto', 'heat_cool']]];
const FAN_ORDER = ['auto', 'low', 'medium', 'high', 'turbo'];

function modeTable(hvacModes = []) {
  const out = {};
  for (const [panel, names] of MODE_NAMES) {
    const name = names.find((n) => hvacModes.includes(n));
    if (name) out[panel] = name;
  }
  return out;
}

function fanPanel(name) {
  const n = String(name).toLowerCase();
  if (['turbo', 'max', 'strong', 'highest', 'powerful', 'boost', 'very high'].some((k) => n.includes(k))) return 'turbo';
  if (n.includes('high')) return 'high';
  if (n.includes('med') || n.includes('mid')) return 'medium';
  if (n.includes('low') || n.includes('quiet') || n.includes('silent')) return 'low';
  if (n.includes('auto')) return 'auto';
  return null;
}

function fanTable(names = []) {
  const out = {};
  for (const name of names) {
    if (String(name).toLowerCase() === 'off') continue;
    const p = fanPanel(name);
    if (p && !out[p]) out[p] = name;
  }
  return out;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex = (r, g, b) => `#${[r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('')}`;
const offline = (s) => !s || s.state === 'unavailable' || s.state === 'unknown';

function lightReading(s) {
  const a = s.attributes || {};
  const light = { on: s.state === 'on' };
  const b = num(a.brightness);
  if (s.state === 'on' && b !== null) light.brightness = clamp(b / 255, 0.05, 1);
  const mode = a.color_mode;
  if (mode === 'color_temp') {
    const k = num(a.color_temp_kelvin);
    if (k !== null) { light.temp = clamp(k, 2200, 6500); light.color = null; }
  } else if (['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(mode) && Array.isArray(a.rgb_color) && a.rgb_color.length >= 3) {
    light.color = hex(...a.rgb_color.slice(0, 3));
  }
  return light;
}

function acReading(s) {
  const a = s.attributes || {};
  const modes = modeTable(a.hvac_modes);
  const ac = { on: s.state !== 'off' };
  const mode = Object.keys(modes).find((k) => modes[k] === s.state);
  if (mode) ac.mode = mode;
  const t = num(a.temperature);
  const lo = num(a.target_temp_low);
  const hi = num(a.target_temp_high);
  if (t !== null) ac.target = t;
  else if (lo !== null && hi !== null) ac.target = Math.round((lo + hi) / 2);
  const room = num(a.current_temperature);
  if (room !== null) ac.roomTemp = room;
  const fans = fanTable(a.fan_modes);
  const fan = a.fan_mode ? fanPanel(a.fan_mode) : null;
  if (fan && fans[fan]) ac.fan = fan;
  const swings = a.swing_modes || [];
  if (a.swing_mode && swings.length) ac.swing = a.swing_mode === 'off' ? 'off' : 'swing';
  const presets = a.preset_modes || [];
  if (presets.includes('sleep')) ac.sleep = a.preset_mode === 'sleep';
  if (presets.includes('eco')) ac.eco = a.preset_mode === 'eco';
  const features = {
    modes: ['cool', 'heat', 'dry', 'fan', 'auto'].filter((m) => modes[m]),
    fans: FAN_ORDER.filter((f) => fans[f]),
    swing: swings.includes('off') && swings.length > 1,
    sleep: presets.includes('sleep'),
    eco: presets.includes('eco'),
  };
  return { ac, features };
}

function sensorTemperature(s) {
  const t = num(s.state);
  if (t === null) return null;
  return s.attributes?.unit_of_measurement === '°F' ? Math.round(((t - 32) * 5 / 9) * 10) / 10 : t;
}

function serviceCalls(entityId, patch, state, attributes = {}) {
  const domain = entityId.split('.')[0];
  const call = (service, data = {}) => ({ domain, service, data: { entity_id: entityId, ...data } });

  if (domain === 'switch' || domain === 'input_boolean' || domain === 'fan') {
    if (typeof patch.on !== 'boolean') return [];
    return [call(patch.on ? 'turn_on' : 'turn_off')];
  }
  if (domain === 'light') {
    if (patch.on === false) return [call('turn_off')];
    const data = {};
    if (typeof patch.brightness === 'number') data.brightness_pct = Math.round(patch.brightness * 100);
    if (typeof patch.temp === 'number') data.color_temp_kelvin = Math.round(patch.temp);
    if (typeof patch.color === 'string' && /^#?[0-9a-f]{6}$/i.test(patch.color)) {
      const c = patch.color.replace('#', '');
      data.rgb_color = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
    }
    if (!Object.keys(data).length && patch.on !== true) return [];
    return [call('turn_on', data)];
  }
  if (domain !== 'climate') return [];

  const modes = modeTable(attributes.hvac_modes);
  const fans = fanTable(attributes.fan_modes);
  const out = [];
  if (patch.on === false) return [call('set_hvac_mode', { hvac_mode: 'off' })];
  if (patch.on === true || patch.mode) {
    const mode = patch.mode || state.mode || 'cool';
    const name = modes[mode] || Object.values(modes)[0];
    if (name) out.push(call('set_hvac_mode', { hvac_mode: name }));
  }
  if (typeof patch.target === 'number') out.push(call('set_temperature', { temperature: patch.target }));
  if (patch.fan && fans[patch.fan]) out.push(call('set_fan_mode', { fan_mode: fans[patch.fan] }));
  if (patch.swing) out.push(call('set_swing_mode', { swing_mode: patch.swing === 'off' ? 'off' : 'on' }));
  for (const preset of ['sleep', 'eco']) {
    if (typeof patch[preset] === 'boolean') out.push(call('set_preset_mode', { preset_mode: patch[preset] ? preset : 'none' }));
  }
  return out;
}

/* ---------- plan helpers ---------- */

function haLink(d) {
  return d?.link?.service === 'homeassistant' && d.link.id ? d.link.id : null;
}

function encodePlan(plan) {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// Imported files are data, never executable markup. Limit both payload and GPU workload.
const MAX_PLAN_BYTES = 1024 * 1024;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJSON = (a, b) => stableJSON(a) === stableJSON(b);
function stableJSON(v) {
  if (Array.isArray(v)) return `[${v.map(stableJSON).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJSON(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function validatePlan(plan, { acRule = true, awayScene = 'away' } = {}) {
  const need = (ok, text) => { if (!ok) throw new Error(`地图校验失败：${text}`); };
  need(object(plan), '需要 JSON 对象');
  need(new TextEncoder().encode(JSON.stringify(plan)).length <= MAX_PLAN_BYTES, '文件不能超过 1 MB');
  function safe(v, depth = 0) {
    need(depth <= 20, '嵌套层级过深');
    if (typeof v === 'number') need(Number.isFinite(v), '数值必须有限');
    if (typeof v === 'string') need(v.length <= 500, '文本过长');
    if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) {
      need(!['__proto__', 'prototype', 'constructor'].includes(k), '包含危险字段');
      safe(val, depth + 1);
    }
  }
  safe(plan);
  const point = (p, n = 2) => Array.isArray(p) && p.length === n && p.every((x) => Number.isFinite(x) && Math.abs(x) <= 100);
  const color = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  const limits = { rooms: 100, lights: 256, acs: 64, scenes: 64, furniture: 500, openings: 300 };
  const ids = new Set();
  for (const [group, limit] of Object.entries(limits)) {
    need(plan[group] === undefined || Array.isArray(plan[group]), `${group} 必须为数组`);
    need((plan[group] || []).length <= limit, `${group} 数量超过 ${limit}`);
    for (const item of plan[group] || []) {
      need(object(item), `${group} 项必须为对象`);
      if (!['furniture', 'openings'].includes(group)) {
        need(typeof item.id === 'string' && /^[a-zA-Z0-9_.-]+$/.test(item.id) && item.id.length <= 100, `${group} 的 id 无效`);
        need(!ids.has(item.id), `重复 id ${item.id}`); ids.add(item.id);
      }
      if (item.name !== undefined) need(typeof item.name === 'string', `${group} 名称必须为文本`);
    }
  }
  need(plan.rooms?.length > 0, '至少需要一个房间');
  if (plan.name !== undefined) need(typeof plan.name === 'string', '名称必须为文本');
  const rooms = new Set(plan.rooms.map((r) => r.id));
  for (const r of plan.rooms) {
    need(point(r.rect, 4) && r.rect[2] > 0 && r.rect[3] > 0, `${r.id} 房间尺寸无效`);
    need(r.floor === undefined || ['oak', 'walnut', 'tile', 'stone'].includes(r.floor), `${r.id} 地板类型无效`);
  }
  for (const key of ['wallHeight', 'interiorWallHeight']) if (key in plan) need(Number.isFinite(plan[key]) && plan[key] >= 0 && plan[key] <= 10, `${key} 无效`);
  if ('outdoorTemp' in plan) need(Number.isFinite(plan.outdoorTemp), 'outdoorTemp 无效');
  if ('camera' in plan) {
    need(object(plan.camera), 'camera 必须为对象');
    for (const k of ['azimuth', 'elevation']) if (k in plan.camera) need(Number.isFinite(plan.camera[k]), `camera.${k} 无效`);
  }
  const bindings = new Set();
  for (const group of ['lights', 'acs']) for (const d of plan[group] || []) {
    need(rooms.has(d.room) && point(d.pos), `${d.id} 房间引用或位置无效`);
    for (const k of ['y', 'rot', 'length', 'min', 'max']) if (k in d) need(Number.isFinite(d[k]) && Math.abs(d[k]) <= 10000, `${d.id}.${k} 无效`);
    if (d.color !== undefined) need(color(d.color), `${d.id} 色彩无效`);
    need(!('tuya' in d), `${d.id} 不支持其他平台绑定`);
    if (group === 'lights') {
      need(['ceiling', 'pendant', 'spots', 'floor', 'table', 'strip'].includes(d.type), `${d.id} 灯具类型无效`);
      need(d.capabilities === undefined || (Array.isArray(d.capabilities) && d.capabilities.every((c) => ['brightness', 'temp', 'color'].includes(c))), `${d.id} capabilities 无效`);
      if ('length' in d) need(d.length > 0 && d.length <= 100, `${d.id} 长度无效`);
    } else {
      need(['north', 'south', 'east', 'west'].includes(d.wall), `${d.id} 安装方向无效`);
      need((d.min ?? 16) < (d.max ?? 30) && (d.min ?? 16) >= 5 && (d.max ?? 30) <= 40, `${d.id} 温度范围无效`);
    }
    for (const k of ['link', 'sensor']) if (d[k] !== undefined) {
      const link = d[k];
      need(object(link) && link.service === 'homeassistant' && typeof link.id === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(link.id), `${d.id}.${k} 需要有效的 Home Assistant 实体`);
      const domains = k === 'sensor' ? ['sensor'] : group === 'acs' ? ['climate'] : ['light', 'switch', 'input_boolean', 'fan'];
      need(domains.includes(link.id.split('.')[0]), `${d.id}.${k} 实体类型不适用`);
      bindings.add(link.id);
    }
  }
  const furniture = ['rug', 'sofa', 'armchair', 'coffeeTable', 'tv', 'sideboard', 'diningSet', 'island', 'kitchen', 'fridge', 'bed', 'nightstand', 'dresser', 'plant', 'vanity', 'bathtub', 'toilet', 'desk', 'wardrobe', 'bookshelf'];
  for (const f of plan.furniture || []) {
    need(furniture.includes(f.type) && point(f.pos), '家具类型或位置无效');
    for (const k of ['width', 'height']) if (k in f) need(Number.isFinite(f[k]) && f[k] > .1 && f[k] < 12, `家具 ${k} 无效`);
    if ('rot' in f) need(Number.isFinite(f.rot), '家具旋转无效');
    if ('size' in f) need(point(f.size) && f.size.every((x) => x > .1 && x < 15), '家具 size 无效');
    if ('color' in f) need(color(f.color), '家具颜色无效');
    for (const k of ['chairs', 'stools']) if (k in f) need(Number.isInteger(f[k]) && f[k] >= 0 && f[k] <= 12, `家具 ${k} 无效`);
    if ('upper' in f) need(typeof f.upper === 'boolean', '家具 upper 无效');
  }
  for (const o of plan.openings || []) {
    need(['door', 'window', 'open'].includes(o.type || 'door') && point(o.from) && point(o.to), '门窗端点或类型无效');
    need(o.from[0] === o.to[0] || o.from[1] === o.to[1], '门窗必须沿坐标轴对齐');
    for (const k of ['sill', 'head']) if (k in o) need(Number.isFinite(o[k]), `门窗 ${k} 无效`);
  }
  for (const scene of plan.scenes || []) {
    need(['sun', 'sofa', 'film', 'moon', 'door', 'bed', 'tv', 'sparkles'].includes(scene.icon || 'sun'), `${scene.id} 场景图标无效`);
    for (const group of ['lights', 'acs']) {
      const patches = scene[group] || {};
      need(object(patches), `${scene.id}.${group} 必须为对象`);
      const deviceIds = new Set((plan[group] || []).map((d) => d.id));
      const keys = group === 'lights' ? LIGHT_KEYS : AC_KEYS;
      for (const [id, patch] of Object.entries(patches)) {
        need(id === '*' || deviceIds.has(id), `${scene.id} 引用了未知设备 ${id}`);
        need(object(patch) && Object.keys(patch).every((k) => keys.includes(k)), `${scene.id} 控制字段无效`);
        for (const k of ['on', 'sleep', 'eco']) if (k in patch) need(typeof patch[k] === 'boolean', `${scene.id}.${k} 必须为布尔值`);
        for (const k of ['brightness', 'temp', 'target']) if (k in patch) need(Number.isFinite(patch[k]), `${scene.id}.${k} 必须为数值`);
        if ('brightness' in patch) need(patch.brightness >= 0 && patch.brightness <= 1, `${scene.id} 亮度超范围`);
        if (patch.color != null) need(typeof patch.color === 'string' && /^#?[0-9a-f]{6}$/i.test(patch.color), `${scene.id} 颜色无效`);
        for (const [k, choices] of [['mode', ['cool', 'heat', 'dry', 'fan', 'auto']], ['fan', FAN_ORDER], ['swing', ['off', 'swing']]]) if (k in patch) need(choices.includes(patch[k]), `${scene.id}.${k} 无效`);
      }
    }
    // This home's established rule: only the Away scene may turn ACs off. It is on by default
    // for this deployment; set `ac_rule: false` for a home that wants scenes to drive ACs,
    // and `away_scene: leave` if the leaving scene is not called "away".
    if (acRule) need(sameJSON(scene.acs || {}, scene.id === awayScene ? { '*': { on: false } } : {}), `${scene.id} 违反空调规则：只有${awayScene === 'away' ? '离家' : ` ${awayScene} `}可关空调，其他场景不得调整空调`);
  }
  return bindings;
}
function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function findCards(value, path = [], out = []) {
  if (Array.isArray(value)) value.forEach((child, i) => findCards(child, [...path, i], out));
  else if (object(value)) {
    if (value.type === 'custom:house-control-card') out.push({ card: value, path });
    for (const [key, child] of Object.entries(value)) if (key !== 'plan') findCards(child, [...path, key], out);
  }
  return out;
}
function atPath(value, path) { return path.reduce((v, k) => v[k], value); }

/* ---------- the card ---------- */

class HouseControlCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._ready = false;
    this._seen = new Map(); // entity_id -> the state object last pushed
    this._onMessage = this._onMessage.bind(this);
  }

  static getStubConfig() {
    return { height: 640, plan: { name: '我的家', rooms: [{ id: 'living', name: '客厅', rect: [0, 0, 5, 4] }] } };
  }

  setConfig(config) {
    if (!config || typeof config.plan !== 'object' || !Array.isArray(config.plan.rooms)) {
      throw new Error('house-control-card: 需要 "plan"（House Control 的 plan.json 内容）');
    }
    if (this._saving && this._config) {
      const expected = { ...this._config, plan: this._preview || this._config.plan };
      if (!sameJSON(config, this._config) && !sameJSON(config, expected)) this._saveConflict = true;
      // A successful HA save may deliver the expected new config before its reply.
      // Keep our snapshot stable until the read-back completes.
      return;
    }
    const keepPreview = this._preview && this._config && sameJSON(config.plan, this._config.plan);
    this._config = structuredClone(config);
    if (!keepPreview) { this._preview = null; this._previewName = ''; }
    this._loadPlan(this._preview || this._config.plan);
  }

  _loadPlan(plan) {
    this._activePlan = plan;
    this._lights = new Map((plan.lights || []).filter(haLink).map((l) => [l.id, l]));
    this._acs = new Map((plan.acs || []).filter(haLink).map((a) => [a.id, a]));
    this._watched = new Set();
    for (const l of this._lights.values()) this._watched.add(haLink(l));
    for (const a of this._acs.values()) {
      this._watched.add(haLink(a));
      if (a.sensor?.service === 'homeassistant' && a.sensor.id) this._watched.add(a.sensor.id);
    }
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._updateTools();
    if (this._ready) this._push(first);
  }

  getCardSize() { return Math.ceil(this._height() / 50); }

  getGridOptions() {
    return { columns: 'full', rows: Math.ceil((this._height() + 8) / 64), min_columns: 6, min_rows: 6 };
  }

  connectedCallback() { window.addEventListener('message', this._onMessage); }

  disconnectedCallback() {
    window.removeEventListener('message', this._onMessage);
    this._importGeneration = (this._importGeneration || 0) + 1;
    this._importing = false;
    if (this._saving) this._saveConflict = true;
    else this._notice = '';
    this._updateTools();
  }

  _height() { return Number(this._config?.height) || 640; }

  _render() {
    const encoded = encodePlan(this._activePlan);
    const app = new URL(this._config.app_url || APP_URL, document.baseURI);
    if (!['http:', 'https:'].includes(app.protocol) || app.username || app.password) throw new Error('地图程序地址无效');
    // The plan rides in the #hash, which browsers never send to the server hosting the app.
    app.searchParams.set('embed', 'ha');
    app.searchParams.set('v', `${VERSION}-${hashString(encoded)}`);
    // Optional: pin the rendering tier. Omit it and the stage picks one from the device and
    // steps down on its own if frames stay slow. high = sharpest, low = fastest.
    const quality = String(this._config?.quality || '').toLowerCase();
    if (['high', 'medium', 'low'].includes(quality)) app.searchParams.set('q', quality);
    app.hash = encoded;
    const src = app.href;
    if (this._frame && this._src === src) { this._updateTools(); return; }
    this._src = src;
    this._ready = false;
    this._seen.clear();
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card { display: block; width: 100%; overflow: hidden; height: 100%; min-height: ${this._height()}px; background: #0a0e1a; position: relative; }
        iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #0a0e1a; }
        .tools { position: absolute; z-index: 8; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%); width: max-content; max-width: calc(100% - 32px); box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 18px; border: 1px solid #ffffff15; border-radius: 28px; background: rgba(15, 16, 20, .94); color: #f1f3f8; box-shadow: 0 12px 42px #0007, inset 0 1px 0 #ffffff05; backdrop-filter: blur(24px) saturate(125%); -webkit-backdrop-filter: blur(24px) saturate(125%); font: 12px/1.4 system-ui, sans-serif; }
        .tools.opening { animation: island-in .38s cubic-bezier(.16, 1, .3, 1); }
        @keyframes island-in { from { opacity: 0; transform: translateX(-50%) translateY(12px) scale(.88, .8); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
        .status-wrap { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .status-dot { width: 6px; height: 6px; flex: none; background: #78bb9c; border-radius: 50%; box-shadow: 0 0 8px #78bb9c44; }
        .tools.preview .status-dot { background: #f1bf6b; box-shadow: 0 0 8px #f1bf6b44; }
        .tools.busy .status-dot { animation: pulse 1s ease-in-out infinite alternate; }
        @keyframes pulse { to { opacity: .35; } }
        .status { max-width: 240px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #afb3bf; }
        .tool-actions { display: flex; align-items: center; gap: 7px; flex: none; }
        button { border: 1px solid #ffffff10; border-radius: 17px; padding: 7px 12px; background: #ffffff08; color: #dde2ed; font: inherit; cursor: pointer; min-height: 32px; white-space: nowrap; transition: background .2s, transform .2s; }
        button:hover { background: #ffffff14; color: #fff; }
        button:active { transform: scale(.96); }
        button:focus-visible { outline: 2px solid #8bbcff; outline-offset: 3px; }
        button.primary { background: #b5cff5; color: #172136; border-color: transparent; font-weight: 600; }
        button:disabled { opacity: .4; cursor: not-allowed; }
        .collapse { width: 30px; min-height: 30px; padding: 0; display: grid; place-items: center; border-radius: 50%; color: #858a98; background: transparent; border-color: transparent; font-size: 19px; }
        [hidden] { display: none !important; }
        dialog { position: absolute; inset: 12px; margin: auto; box-sizing: border-box; max-width: 440px; max-height: calc(100% - 24px); overflow: auto; border: 1px solid #ffffff19; border-radius: 26px; padding: 24px; background: #15161c; color: #e8ebf2; font: 14px/1.65 system-ui, sans-serif; box-shadow: 0 18px 70px #0008; }
        dialog::backdrop { background: #0006; }
        dialog h3 { margin: 0 0 12px; font-size: 19px; }
        dialog p { margin: 0 0 12px; color: #b5bac8; }
        dialog .actions { display: flex; gap: 8px; justify-content: flex-end; }
        @media(max-width: 760px) { .tools { gap: 7px; padding: 10px 12px; flex-wrap: wrap; justify-content: center; border-radius: 24px; } .status-wrap { width: 100%; padding: 0 4px; } .status { max-width: 100%; flex: 1; font-size: 11px; } .tool-actions { gap: 6px; } button { padding: 7px 10px; font-size: 12px; } }
        @media(prefers-reduced-motion: reduce) { .tools.opening, .tools.busy .status-dot { animation: none; } button { transition: none; } }
      </style>
      <ha-card>
        <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="家庭 3D 户型"></iframe>
        <div class="tools" hidden inert role="region" aria-label="地图编辑工具">
          <div class="status-wrap"><span class="status-dot" aria-hidden="true"></span><span class="status" role="status" aria-live="polite"></span></div>
          <div class="tool-actions">
            <button class="import" title="选择 House Control 导出的 plan.json">导入地图</button>
            <button class="export" title="导出当前地图 JSON">导出</button>
            <button class="reset" hidden>取消预览</button>
            <button class="save primary" hidden>保存到 HA</button>
            <button class="collapse" title="收起编辑工具" aria-label="收起编辑工具">×</button>
          </div>
          <input class="file" type="file" accept=".json,application/json" hidden>
        </div>
        <dialog><h3>替换仪表盘地图？</h3>
          <p class="summary"></p>
          <p>保存只替换当前卡片的地图配置，不会开灯或调整空调。保存后恢复真实设备控制，刷新页面及其他终端会读取新地图。</p>
          <p>将自动下载原地图备份，请保留下载文件。iCloud 和 Mac App 的源文件不会被改动。</p>
          <div class="actions"><button class="cancel-save">取消</button><button class="confirm-save primary">确认保存</button></div>
        </dialog>
      </ha-card>`;
    // sandbox without allow-same-origin: the 3D app runs in an opaque origin and can reach
    // nothing of Home Assistant; all it can do is post commands, which _command vets.
    this._frame = this.shadowRoot.querySelector('iframe');
    this._frame.src = src;
    const root = this.shadowRoot;
    root.querySelector('.collapse').onclick = () => this._setToolsOpen(false, true);
    root.querySelector('.tools').onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._setToolsOpen(false, true); }
    };
    root.querySelector('.import').onclick = () => root.querySelector('.file').click();
    root.querySelector('.file').onchange = (e) => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (file) this._importFile(file);
    };
    root.querySelector('.export').onclick = () => downloadJSON(this._activePlan, 'plan.json');
    root.querySelector('.reset').onclick = () => {
      this._importGeneration = (this._importGeneration || 0) + 1;
      this._preview = null; this._previewName = ''; this._notice = '';
      this._loadPlan(this._config.plan);
    };
    root.querySelector('.save').onclick = () => this._confirmSave();
    root.querySelector('.cancel-save').onclick = () => root.querySelector('dialog').close();
    root.querySelector('.confirm-save').onclick = () => { root.querySelector('dialog').close(); this._savePlan(); };
    this._updateTools();
  }

  _setToolsOpen(open, restoreFocus = false) {
    this._toolsOpen = Boolean(open);
    this._updateTools();
    if (this._toolsOpen) this.shadowRoot.querySelector('.tools')?.classList.add('opening');
    else this.shadowRoot.querySelector('.tools')?.classList.remove('opening');
    if (restoreFocus) this._syncEditor(true);
  }

  _syncEditor(restoreFocus = false) {
    this._send('setEditorState', { open: Boolean(this._toolsOpen), preview: Boolean(this._preview), busy: Boolean(this._importing || this._saving), restoreFocus });
  }

  _updateTools() {
    const root = this.shadowRoot;
    const tools = root.querySelector('.tools');
    if (!tools) return;
    tools.hidden = !this._toolsOpen;
    tools.inert = !this._toolsOpen;
    tools.classList.toggle('preview', Boolean(this._preview));
    tools.classList.toggle('busy', Boolean(this._saving || this._importing));
    root.querySelector('.status').textContent = this._notice || (this._preview
      ? `只读预览 · 控制已暂停 · ${this._previewName || '未保存地图'}`
      : '地图保存在 HA · 导入不会操作设备');
    root.querySelector('.status').title = root.querySelector('.status').textContent;
    for (const name of ['reset', 'save']) root.querySelector(`.${name}`).hidden = !this._preview;
    root.querySelector('.save').disabled = this._saving || this._importing || !this._ready || !this._hass?.user?.is_admin;
    root.querySelector('.save').title = this._hass?.user?.is_admin ? '确认后永久保存到当前仪表盘' : '需要管理员账号才能保存';
    for (const name of ['import', 'reset', 'export']) root.querySelector(`.${name}`).disabled = Boolean(this._saving || this._importing);
    this._syncEditor();
  }

  async _checkBindings(plan) {
    const entities = validatePlan(plan, { acRule: this._config.ac_rule !== false, awayScene: this._config.away_scene || 'away' });
    if (!entities.size) return;
    if (!this._hass?.connection) throw new Error('HA 尚未连接，无法校验设备来源');
    // Only let a plan bind to entities from one integration. Defaults to Xiaomi Home (the
    // integration this was built against); set `platform: mqtt` etc. to match another one,
    // or `platform: "*"` to accept any integration.
    const required = this._config.platform === undefined ? 'xiaomi_home' : this._config.platform;
    const registry = await this._hass.connection.sendMessagePromise({ type: 'config/entity_registry/list' });
    const indexed = new Map(registry.map((e) => [e.entity_id, e]));
    for (const id of entities) {
      const e = indexed.get(id);
      if (!e) throw new Error(`设备不存在：${id}`);
      if (required && required !== '*' && e.platform !== required) throw new Error(`设备 ${id} 来自 ${e.platform || '未知集成'}；此地图只允许 ${required === 'xiaomi_home' ? 'Xiaomi Home' : required}`);
      if (e.disabled_by) throw new Error(`设备已禁用：${id}`);
    }
  }

  async _importFile(file) {
    if (this._saving || this._importing) return;
    const generation = this._importGeneration = (this._importGeneration || 0) + 1;
    this._importing = true; this._notice = '正在校验地图与 Xiaomi Home 绑定…'; this._updateTools();
    try {
      if (file.size > MAX_PLAN_BYTES) throw new Error('地图文件不能超过 1 MB');
      const plan = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      await this._checkBindings(plan);
      if (generation !== this._importGeneration || !this.isConnected) return;
      this._preview = structuredClone(plan); this._previewName = file.name;
      this._notice = '';
      this._loadPlan(this._preview);
    } catch (err) {
      if (generation === this._importGeneration) this._notice = `导入失败：${err.message || err}`;
    } finally {
      if (generation === this._importGeneration) this._importing = false;
      this._updateTools();
    }
  }

  _confirmSave() {
    if (!this._preview || this._saving || this._importing || !this._ready || !this.isConnected || !this._hass?.user?.is_admin) return;
    const p = this._preview;
    this.shadowRoot.querySelector('.summary').textContent = `${p.name || '未命名地图'}：${p.rooms.length} 个房间、${(p.lights || []).length} 个灯光模型、${(p.acs || []).length} 个空调/新风模型。当前设备控制处于暂停状态。`;
    this.shadowRoot.querySelector('dialog').showModal();
  }

  _dashboardPath() {
    // null means the default /lovelace dashboard; named storage dashboards use their url_path.
    if (this._config.dashboard_path !== undefined) return this._config.dashboard_path || null;
    const path = location.pathname.split('/').filter(Boolean)[0];
    if (!path) throw new Error('无法定位仪表盘，请配置 dashboard_path');
    return path === 'lovelace' ? null : path;
  }

  _targetCard(dashboard, basePlan) {
    const matches = findCards(dashboard).filter(({ card }) => sameJSON(card.plan, basePlan));
    if (matches.length !== 1) throw new Error('原地图已变化或存在多个相同卡片，请刷新页面后重新导入；未覆盖任何配置');
    if (!sameJSON(matches[0].card, this._config)) throw new Error('卡片配置已被修改，请刷新页面后重新导入；未覆盖任何配置');
    return matches[0];
  }

  async _savePlan() {
    if (!this._preview || this._saving || this._importing || !this._ready || !this.isConnected || !this._hass?.user?.is_admin) return;
    const preview = structuredClone(this._preview);
    const basePlan = structuredClone(this._config.plan);
    const connection = this._hass.connection;
    this._saving = true; this._saveConflict = false;
    this._notice = '正在校验并保存到 HA…'; this._updateTools();
    let wrote = false;
    try {
      await this._checkBindings(preview);
      const url_path = this._dashboardPath();
      const read = () => connection.sendMessagePromise({ type: 'lovelace/config', url_path });
      const before = await read();
      const target = this._targetCard(before, basePlan);
      const latest = await read();
      if (!sameJSON(before, latest) || this._saveConflict || !this.isConnected) throw new Error('仪表盘正在被其他页面修改或已离开，请刷新后重试；未保存');
      // Backup is a user-initiated download, not a public static-file upload.
      downloadJSON(target.card.plan, `plan-before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const after = structuredClone(latest);
      atPath(after, target.path).plan = preview;
      await connection.sendMessagePromise({ type: 'lovelace/config/save', url_path, config: after });
      wrote = true;
      const saved = await read();
      if (!sameJSON(saved, after) || this._saveConflict || !this.isConnected) throw new Error('HA 已接受保存，但回读不一致或页面配置发生变化；请刷新检查，不会自动覆盖其他人的修改');
      this._config = { ...this._config, plan: preview };
      this._preview = null; this._previewName = '';
      this._notice = '已保存到 HA · 原地图备份已发起下载';
      this._loadPlan(preview);
      // The live card now agrees with the dashboard; other clients receive HA's config event.
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: structuredClone(this._config) }, bubbles: true, composed: true }));
    } catch (err) {
      this._notice = `${wrote ? '保存结果待确认' : '保存失败'}：${err.message || err}`;
    } finally {
      this._saving = false; this._updateTools();
    }
  }

  _send(fn, ...args) {
    this._frame?.contentWindow?.postMessage({ __houseHost: 1, fn, args }, '*');
  }

  _onMessage(e) {
    if (!this._frame || e.source !== this._frame.contentWindow || !e.data?.__house) return;
    const msg = e.data.msg || {};
    if (msg.type === 'ready') {
      if (msg.error) { this._ready = false; this._notice = `地图加载失败：${msg.error}`; this._updateTools(); return; }
      this._ready = true;
      this._updateTools();
      this._send('shown');
      if (this._hass) this._push(true);
    } else if (msg.type === 'command') {
      const sender = e.source;
      const reply = (result) => { if (sender === this._frame?.contentWindow) sender.postMessage({ __houseHost: 1, fn: 'reply', args: [msg.callId, result] }, '*'); };
      this._command(msg).then(
        () => reply({}),
        (err) => reply({ error: String(err?.message || err || '调用失败') }),
      );
    } else if (msg.type === 'toggleEdit') {
      this._setToolsOpen(!this._toolsOpen);
    } else if (msg.type === 'close') {
      if (this._toolsOpen) this._setToolsOpen(false, true);
    }
  }

  async _command({ kind, id, patch, state }) {
    if (this._preview || this._saving || this._importing) throw new Error('地图预览/导入期间设备控制已暂停；保存或取消预览后可恢复');
    const activePlan = this._activePlan;
    // Only devices of this card's plan, only their own linked entity, only known fields.
    if (kind !== 'light' && kind !== 'ac') return;
    const cfg = kind === 'light' ? this._lights.get(id) : this._acs.get(id);
    const entity = haLink(cfg);
    if (!entity || !this._hass) return; // not linked: the 3D model just simulates it
    if (!['light', 'switch', 'climate', 'input_boolean', 'fan'].includes(entity.split('.')[0])) return;
    const keys = kind === 'light' ? LIGHT_KEYS : AC_KEYS;
    const clean = pick(patch, keys);
    if ('target' in clean) {
      const t = Number(clean.target);
      if (!Number.isFinite(t)) delete clean.target;
      else clean.target = clamp(Math.round(t * 2) / 2, cfg.min ?? 16, cfg.max ?? 30);
    }
    if ('brightness' in clean && !(typeof clean.brightness === 'number' && clean.brightness >= 0 && clean.brightness <= 1)) delete clean.brightness;
    const attributes = this._hass.states[entity]?.attributes || {};
    for (const c of serviceCalls(entity, clean, pick(state, ['mode']), attributes)) {
      if (this._preview || this._saving || this._importing || activePlan !== this._activePlan || !this.isConnected) throw new Error('地图已切换，取消剩余控制指令');
      await this._hass.callService(c.domain, c.service, c.data);
    }
  }

  // Sends what changed since the last push (everything when `all`).
  _push(all = false) {
    const states = this._hass.states;
    let changed = all;
    if (!all) for (const id of this._watched) if (states[id] !== this._seen.get(id)) { changed = true; break; }
    if (!changed) return;

    const lights = {};
    const acs = {};
    const features = {};
    for (const [id, cfg] of this._lights) {
      const s = states[haLink(cfg)];
      if (!all && s === this._seen.get(haLink(cfg))) continue;
      if (!offline(s)) lights[id] = lightReading(s);
    }
    for (const [id, cfg] of this._acs) {
      const entity = haLink(cfg);
      const sensor = cfg.sensor?.service === 'homeassistant' ? cfg.sensor.id : null;
      const s = states[entity];
      const t = sensor ? states[sensor] : null;
      if (!all && s === this._seen.get(entity) && (!sensor || t === this._seen.get(sensor))) continue;
      let ac = {};
      if (!offline(s)) {
        const r = acReading(s);
        ac = r.ac;
        features[id] = r.features;
      }
      if (t && !offline(t)) {
        const temp = sensorTemperature(t);
        if (temp !== null) ac.roomTemp = temp;
      }
      if (Object.keys(ac).length) acs[id] = ac;
    }
    for (const id of this._watched) this._seen.set(id, states[id]);
    this._send('applyRemote', { lights, acs, features });
  }
}

if (!customElements.get('house-control-card')) customElements.define('house-control-card', HouseControlCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'house-control-card')) {
  window.customCards.push({
    type: 'house-control-card',
    name: 'House Control 3D 户型',
    description: '可交互的 3D 户型图：点灯开关、调空调、一键场景（House Control）',
    preview: false,
  });
}
console.info(`%c HOUSE-CONTROL-CARD %c ${VERSION} `, 'background:#3d8bff;color:#fff;border-radius:3px 0 0 3px', 'background:#17274f;color:#fff;border-radius:0 3px 3px 0');
