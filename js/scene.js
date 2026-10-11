/* ==========================================================================
   Fuji Sushibar — scène 3D (Three.js r170)

   - Un hosomaki au saumon entièrement procédural : nori, riz grain par grain,
     cœur de saumon. Toutes les textures sont dessinées au chargement.
   - Un rendu « dessiné à la main » : formes irrégulières, riz en aplats,
     traits d'encre (contours et traits posés sur les faces) dont l'épaisseur
     « bouillonne » 8 fois par seconde, comme dans un dessin animé.
   - Le plateau de la section « Menus », garni des pièces du menu choisi.
   - Le plan de travail vu de dessus (planche en hinoki, makisu, baguettes,
     couteau, coupelle de sauce soja) pour la scène d'ouverture.
   - Une main (modèle « generic-hand » WebXR, licence MIT) qui tient des
     baguettes. Le modèle est lissé (subdivision de Loop) puis posé par
     cinématique directe, articulation par articulation.

   Script classique : Three.js est chargé par import() dynamique grâce à
   l'importmap de index.html, ce qui permet d'ouvrir le site en double-cliquant
   sur index.html (file://) aussi bien que depuis un serveur.
   Unités : 1 = 1 cm. Le plan de travail est le plan XY, la caméra regarde -Z.
   ========================================================================== */
(function () {
  'use strict';

  const HAND_URL =
    'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/right.glb';

  /* ---------------------------------------------------------------- outils */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Bruit de valeur 2D, périodique si px / py sont fournis (textures raccordables).
  function makeNoise(seed) {
    const rnd = mulberry32(seed);
    const perm = new Uint16Array(512);
    const val = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      perm[i] = i;
      val[i] = rnd();
    }
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    return function (x, y, px, py) {
      let xi = Math.floor(x);
      let yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      let x1 = xi + 1;
      let y1 = yi + 1;
      if (px) {
        xi = ((xi % px) + px) % px;
        x1 = ((x1 % px) + px) % px;
      }
      if (py) {
        yi = ((yi % py) + py) % py;
        y1 = ((y1 % py) + py) % py;
      }
      xi &= 255;
      x1 &= 255;
      yi &= 255;
      y1 &= 255;
      const a = val[perm[xi + perm[yi]]];
      const b = val[perm[x1 + perm[yi]]];
      const c = val[perm[xi + perm[y1]]];
      const d = val[perm[x1 + perm[y1]]];
      const u = fx * fx * (3 - 2 * fx);
      const v = fy * fy * (3 - 2 * fy);
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
  }

  function fbm(noise, x, y, oct, px, py) {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      s += amp * noise(x * f, y * f, px ? px * f : 0, py ? py * f : 0);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return s / norm;
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // Carte de hauteur → carte de normales (espace tangent, convention OpenGL).
  function heightToNormal(h, W, H, strength, wrapX, wrapY) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const yu = wrapY ? (y - 1 + H) % H : Math.max(0, y - 1);
      const yd = wrapY ? (y + 1) % H : Math.min(H - 1, y + 1);
      for (let x = 0; x < W; x++) {
        const xl = wrapX ? (x - 1 + W) % W : Math.max(0, x - 1);
        const xr = wrapX ? (x + 1) % W : Math.min(W - 1, x + 1);
        const dx = (h[y * W + xr] - h[y * W + xl]) * strength;
        const dy = (h[yd * W + x] - h[yu * W + x]) * strength;
        let nx = -dx;
        let ny = dy;
        let nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        const i = (y * W + x) * 4;
        out[i] = (nx * 0.5 + 0.5) * 255;
        out[i + 1] = (ny * 0.5 + 0.5) * 255;
        out[i + 2] = (nz * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  function canvasTexture(THREE, cv, { srgb = true, wrap = false, repeat = null, aniso = 8 } = {}) {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = aniso;
    return t;
  }

  function dataCanvas(W, H, data) {
    const cv = makeCanvas(W, H);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  function bbox(pts) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  }

  /* --------------------------------------------- encre : un trait « dessiné » */

  // Uniformes partagés par tous les matériaux encrés : le trait « bouillonne »
  // 8 fois par seconde, comme dans un dessin animé fait à la main.
  const INK = { boil: { value: 0 }, color: { value: null }, res: { value: null } };

  const INK_NOISE = `
float inkHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float inkNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(inkHash(i), inkHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(inkHash(i + vec3(0.0, 1.0, 0.0)), inkHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(inkHash(i + vec3(0.0, 0.0, 1.0)), inkHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(inkHash(i + vec3(0.0, 1.0, 1.0)), inkHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

  // Ajoute à un matériau standard / physique un cerne d'encre d'épaisseur
  // irrégulière sur les bords (selon l'angle de vue) et un très léger
  // tremblement des formes.
  function inkify(mat, { width = 0.3, strength = 0.8, wobble = 0.01, scale = 3 } = {}) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uBoil: INK.boil,
        uInk: INK.color,
        uInkW: { value: width },
        uInkS: { value: strength },
        uWob: { value: wobble },
        uInkScale: { value: scale },
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uBoil;
uniform float uWob;
varying vec3 vInkPos;
${INK_NOISE}`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vec3 inkP = position;
#ifdef USE_INSTANCING
  inkP = (instanceMatrix * vec4(position, 1.0)).xyz;
#endif
vInkPos = inkP;
transformed += objectNormal * (inkNoise(inkP * 2.3 + uBoil * 3.17) - 0.5) * uWob;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uBoil;
uniform vec3 uInk;
uniform float uInkW;
uniform float uInkS;
uniform float uInkScale;
varying vec3 vInkPos;
${INK_NOISE}`
        )
        .replace(
          '#include <opaque_fragment>',
          `{
  float inkNdv = abs(dot(normalize(normal), normalize(vViewPosition)));
  float inkN = inkNoise(vInkPos * uInkScale + uBoil * 7.31);
  float inkW = uInkW * (0.55 + 0.9 * inkN);
  outgoingLight = mix(outgoingLight, uInk, (1.0 - smoothstep(inkW * 0.45, inkW, inkNdv)) * uInkS);
}
#include <opaque_fragment>`
        );
    };
    mat.customProgramCacheKey = () => 'fuji-ink';
    return mat;
  }

  // Contour d'un volume : coque inversée (faces arrière poussées vers
  // l'extérieur, à l'écran) dont l'épaisseur en pixels varie le long du trait
  // et change à chaque « bouillonnement ».
  function inkHullMaterial(THREE, { width = 1.6, vary = 0.9, scale = 3, seed = 0, color = null } = {}) {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uBoil: INK.boil,
        uInk: color ? { value: new THREE.Color(color) } : INK.color,
        uRes: INK.res,
        uW: { value: width },
        uVary: { value: vary },
        uScale: { value: scale },
        uSeed: { value: seed },
      },
      vertexShader: `
uniform float uBoil;
uniform vec2 uRes;
uniform float uW;
uniform float uVary;
uniform float uScale;
uniform float uSeed;
${INK_NOISE}
void main() {
  vec3 p = position;
  vec3 n = normal;
#ifdef USE_INSTANCING
  vec3 s = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  n = mat3(instanceMatrix) * (n / (s * s));
  p = (instanceMatrix * vec4(p, 1.0)).xyz;
#endif
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vec3 nv = normalize(normalMatrix * n);
  vec2 d = (projectionMatrix * vec4(nv, 0.0)).xy * uRes;
  float l = length(d);
  d = l > 1e-5 ? d / l : vec2(0.0);
  float k = inkNoise(p * uScale + vec3(uSeed) + uBoil * 5.13);
  float px = uW * (1.0 - 0.5 * uVary + uVary * k);
  clip.xy += d * px * 2.0 / uRes * clip.w;
  gl_Position = clip;
}`,
      fragmentShader: `
uniform vec3 uInk;
void main() {
  gl_FragColor = vec4(uInk, 1.0);
  #include <colorspace_fragment>
}`,
    });
  }

  // Rampe d'éclairage en quelques tons francs (MeshToonMaterial).
  function toneRamp(THREE, levels) {
    const data = new Uint8Array(levels.length * 4);
    levels.forEach((v, i) => data.set([v * 255, v * 255, v * 255, 255], i * 4));
    const t = new THREE.DataTexture(data, levels.length, 1, THREE.RGBAFormat);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  // Volume fermé aux arêtes arrondies dont la section suit un contour
  // (points [x, y] autour de (cx, cy)) : coque lisse pour le trait d'encre.
  function hullPrism(THREE, ring, cx, cy, H, round, cs = 3) {
    const n = ring.length;
    const rows = [];
    for (const top of [false, true]) {
      for (let k = 0; k <= cs; k++) {
        const f = (top ? cs - k : k) / cs;
        const a = (f * Math.PI) / 2;
        const inset = round * (1 - Math.sin(a));
        const z = (top ? 1 : -1) * (H / 2 - round * (1 - Math.cos(a)));
        rows.push({ inset, z });
      }
    }
    const pos = [];
    pos.push(cx, cy, -H / 2);
    for (const { inset, z } of rows) {
      for (const [x, y] of ring) {
        const dx = x - cx;
        const dy = y - cy;
        const l = Math.hypot(dx, dy) || 1;
        const k = Math.max(0, l - inset) / l;
        pos.push(cx + dx * k, cy + dy * k, z);
      }
    }
    pos.push(cx, cy, H / 2);
    const top = pos.length / 3 - 1;
    const idx = [];
    const v = (r, i) => 1 + r * n + (i % n);
    for (let i = 0; i < n; i++) idx.push(0, v(0, i + 1), v(0, i));
    for (let r = 0; r < rows.length - 1; r++) {
      for (let i = 0; i < n; i++) {
        idx.push(v(r, i), v(r, i + 1), v(r + 1, i));
        idx.push(v(r, i + 1), v(r + 1, i + 1), v(r + 1, i));
      }
    }
    const last = rows.length - 1;
    for (let i = 0; i < n; i++) idx.push(top, v(last, i), v(last, i + 1));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Trait d'encre posé à plat sur une face coupée, le long d'un contour fermé
  // (sens trigonométrique) : épaisseur irrégulière, léger tremblé, qui
  // « bouillonne » comme le reste.
  function inkRibbon(THREE, ring, z, { width = 0.05, offset = 0, seed = 0, wander = 0.012 } = {}) {
    const n = ring.length;
    const pos = new Float32Array(n * 6);
    const dir = new Float32Array(n * 4);
    const along = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const [x, y] = ring[i];
      const [xp, yp] = ring[(i - 1 + n) % n];
      const [xn, yn] = ring[(i + 1) % n];
      const tl = Math.hypot(xn - xp, yn - yp) || 1;
      const nx = (yn - yp) / tl;
      const ny = -(xn - xp) / tl;
      for (let s = 0; s < 2; s++) {
        const j = i * 2 + s;
        pos.set([x + nx * offset, y + ny * offset, z], j * 3);
        dir.set([nx, ny], j * 2);
        along[j] = s * 2 - 1;
      }
    }
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('inkDir', new THREE.BufferAttribute(dir, 2));
    g.setAttribute('inkSide', new THREE.BufferAttribute(along, 1));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        uBoil: INK.boil,
        uInk: INK.color,
        uW: { value: width },
        uWander: { value: wander },
        uSeed: { value: seed },
      },
      vertexShader: `
attribute vec2 inkDir;
attribute float inkSide;
uniform float uBoil;
uniform float uW;
uniform float uWander;
uniform float uSeed;
${INK_NOISE}
void main() {
  vec3 q = position * 2.6 + vec3(uSeed, uSeed * 0.7, 0.0);
  float b = uBoil * 3.71;
  float w = uW * (0.3 + 1.25 * inkNoise(q + b));
  float shift = (inkNoise(q * 0.7 + b + 19.0) - 0.5) * 2.0 * uWander;
  vec3 p = position + vec3(inkDir * (shift + inkSide * w * 0.5), 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,
      fragmentShader: `
uniform vec3 uInk;
void main() {
  gl_FragColor = vec4(uInk, 1.0);
  #include <colorspace_fragment>
}`,
    });
    return new THREE.Mesh(g, mat);
  }

  /* --------------------------------------- dessin « à main levée » (canvas) */

  // Courbe fermée lissée passant près des points, légèrement tremblée.
  function smoothClosed(ctx, pts, rnd, jitter) {
    const n = pts.length;
    const p = pts.map(([x, y]) => [x + (rnd() - 0.5) * jitter, y + (rnd() - 0.5) * jitter]);
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = mid(p[n - 1], p[0]);
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) {
      const e = mid(p[i], p[(i + 1) % n]);
      ctx.quadraticCurveTo(p[i][0], p[i][1], e[0], e[1]);
    }
    ctx.closePath();
  }

  // Contour à l'encre brune : un trait franc et un second, plus fin, décalé.
  function inkLine(ctx, pts, rnd, width, alpha = 0.85) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(42, 22, 12, ${alpha})`;
    ctx.lineWidth = width;
    smoothClosed(ctx, pts, rnd, width * 0.6);
    ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = width * 0.45;
    smoothClosed(ctx, pts, rnd, width * 1.5);
    ctx.stroke();
    ctx.restore();
  }

  // Cercle irrégulier (liste de points).
  function wobblyRing(cx, cy, r, amp, noise, phase, n = 72) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + amp * (noise((i / n) * 6, phase, 6) - 0.5) * 2);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return pts;
  }

  // « Carré arrondi » irrégulier (super-ellipse) pour les garnitures.
  function blobPoints(cx, cy, a, b, n, rot, noise, phase, amp = 0.06, count = 72) {
    const pts = [];
    const k = 2 / n;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const w = 1 + amp * (noise((i / count) * 8, phase, 8) - 0.5) * 2;
      const x = a * Math.sign(c) * Math.pow(Math.abs(c), k) * w;
      const y = b * Math.sign(s) * Math.pow(Math.abs(s), k) * w;
      pts.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
    }
    return pts;
  }

  // Grains de riz dessinés : ellipses ombrées, cernées d'un trait brun.
  function drawRice(ctx, rnd, box, count, size, outline = 0.5) {
    for (let i = 0; i < count; i++) {
      const x = box[0] + rnd() * (box[2] - box[0]);
      const y = box[1] + rnd() * (box[3] - box[1]);
      const s = size * (0.75 + rnd() * 0.5);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rnd() * Math.PI);
      const g = ctx.createRadialGradient(-s * 0.3, -s * 0.22, s * 0.05, 0, 0, s);
      g.addColorStop(0, '#fffdf8');
      g.addColorStop(0.55, '#ede6d9');
      g.addColorStop(1, '#c9bda9');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, s, s * 0.58, 0, 0, Math.PI * 2);
      ctx.fill();
      if (outline) {
        ctx.strokeStyle = `rgba(74, 48, 32, ${outline})`;
        ctx.lineWidth = Math.max(0.8, s * 0.1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Graines de sésame blanches et noires.
  function drawSesame(ctx, rnd, inside, box, count, size) {
    for (let i = 0; i < count; i++) {
      const x = box[0] + rnd() * (box[2] - box[0]);
      const y = box[1] + rnd() * (box[3] - box[1]);
      if (!inside(x, y)) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rnd() * Math.PI);
      ctx.fillStyle = rnd() < 0.35 ? '#1e1915' : '#f0e2c2';
      ctx.beginPath();
      ctx.ellipse(0, 0, size, size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60, 40, 25, 0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Chair de poisson dans un contour : dégradé, lignes de gras, bord plus
  // sombre et trait d'encre. kind : saumon | thon | dorade.
  function paintFish(ctx, pts, box, rnd, kind, { ink = 1, stripes } = {}) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    const h = y1 - y0;
    ctx.save();
    smoothClosed(ctx, pts, rnd, 0);
    ctx.clip();
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    if (kind === 'thon') {
      g.addColorStop(0, '#d6404f');
      g.addColorStop(1, '#a61d33');
    } else if (kind === 'dorade') {
      g.addColorStop(0, '#fbf0ea');
      g.addColorStop(1, '#efd3c9');
    } else {
      g.addColorStop(0, '#ff9d5e');
      g.addColorStop(0.5, '#ff7e41');
      g.addColorStop(1, '#e65a29');
    }
    ctx.fillStyle = g;
    ctx.fillRect(x0 - 4, y0 - 4, w + 8, h + 8);
    const n = stripes ?? (kind === 'saumon' ? 5 : 4);
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const t = (i + 0.6) / (n + 0.4);
      const sx = x0 + w * (t - 0.2);
      const sy = y0 - h * 0.08;
      const ex = x0 + w * (t + 0.22);
      const ey = y1 + h * 0.08;
      const cx = sx + w * (0.02 + rnd() * 0.08);
      const cy = y0 + h * (0.55 + (rnd() - 0.5) * 0.18);
      const stroke = (lw, col) => {
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(cx, cy, ex, ey);
        ctx.stroke();
      };
      if (kind === 'saumon') {
        stroke(w * 0.07, 'rgba(255, 186, 146, 0.32)');
        stroke(w * (0.012 + rnd() * 0.014), 'rgba(255, 241, 231, 0.92)');
      } else if (kind === 'thon') {
        stroke(w * 0.035, 'rgba(236, 110, 122, 0.22)');
      } else {
        stroke(w * 0.05, 'rgba(236, 160, 150, 0.28)');
      }
    }
    if (kind === 'dorade') {
      // peau rosée et argentée le long d'un bord
      const sk = ctx.createLinearGradient(0, y1 - h * 0.2, 0, y1);
      sk.addColorStop(0, 'rgba(232, 120, 120, 0)');
      sk.addColorStop(0.6, 'rgba(214, 96, 104, 0.55)');
      sk.addColorStop(1, 'rgba(150, 150, 160, 0.8)');
      ctx.fillStyle = sk;
      ctx.fillRect(x0, y1 - h * 0.2, w, h * 0.2);
    }
    ctx.lineWidth = Math.min(w, h) * 0.09;
    ctx.strokeStyle =
      kind === 'thon' ? 'rgba(110, 10, 25, 0.32)' : kind === 'dorade' ? 'rgba(200, 120, 110, 0.25)' : 'rgba(190, 70, 30, 0.3)';
    smoothClosed(ctx, pts, rnd, 0);
    ctx.stroke();
    ctx.restore();
    if (ink) {
      // trait posé un peu à l'intérieur pour ne pas être coupé au bord
      let mx = 0;
      let my = 0;
      pts.forEach(([x, y]) => {
        mx += x / pts.length;
        my += y / pts.length;
      });
      const inner = pts.map(([x, y]) => [mx + (x - mx) * 0.975, my + (y - my) * 0.975]);
      inkLine(ctx, inner, rnd, Math.max(2, Math.min(w, h) * 0.02) * ink);
    }
  }

  function paintCucumber(ctx, cx, cy, r, rnd, noise) {
    const skin = wobblyRing(cx, cy, r, 0.04, noise, 2.2);
    ctx.fillStyle = '#2f6a2b';
    smoothClosed(ctx, skin, rnd, 0);
    ctx.fill();
    ctx.fillStyle = '#a6cd72';
    smoothClosed(ctx, wobblyRing(cx, cy, r * 0.84, 0.04, noise, 3.1), rnd, 0);
    ctx.fill();
    ctx.fillStyle = '#d9e8ab';
    smoothClosed(ctx, wobblyRing(cx, cy, r * 0.46, 0.08, noise, 4.4), rnd, 0);
    ctx.fill();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rnd() * 0.3;
      ctx.fillStyle = '#f4f6dc';
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * r * 0.26, cy + Math.sin(a) * r * 0.26, r * 0.07, r * 0.035, a, 0, Math.PI * 2);
      ctx.fill();
    }
    inkLine(ctx, skin, rnd, Math.max(2, r * 0.05));
  }

  // Tranche d'avocat en demi-lune : bord vert foncé, cœur jaune pâle.
  function paintAvocado(ctx, cx, cy, w, h, rot, rnd) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = Math.PI * (i / 24);
      pts.push([Math.cos(t) * w, -Math.sin(t) * h]);
    }
    pts.push([-w * 0.6, h * 0.08], [w * 0.6, h * 0.08]);
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const P = pts.map(([x, y]) => [cx + x * cr - y * sr, cy + x * sr + y * cr]);
    const g = ctx.createLinearGradient(cx + sr * h, cy - cr * h, cx, cy);
    g.addColorStop(0, '#3f6a1e');
    g.addColorStop(0.25, '#8db03c');
    g.addColorStop(1, '#dfe39a');
    ctx.fillStyle = g;
    smoothClosed(ctx, P, rnd, 0);
    ctx.fill();
    inkLine(ctx, P, rnd, Math.max(2, h * 0.08));
  }

  // Bâtonnet (surimi, omelette…) : un corps et, éventuellement, une bande dessus.
  function paintBlock(ctx, cx, cy, w, h, rot, top, body, rnd, noise) {
    const P = blobPoints(cx, cy, w, h, 5, rot, noise, cx * 0.01, 0.05, 40);
    ctx.save();
    smoothClosed(ctx, P, rnd, 0);
    ctx.clip();
    ctx.fillStyle = body;
    ctx.fillRect(cx - w * 2, cy - h * 2, w * 4, h * 4);
    if (top) {
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.fillStyle = top;
      ctx.fillRect(-w * 1.2, -h * 1.2, w * 2.4, h * 0.75);
    }
    ctx.restore();
    inkLine(ctx, P, rnd, Math.max(2, Math.min(w, h) * 0.12));
  }

  /* -------------------------------------------------------------- textures */

  // Nori : presque noir, froissé, avec de fines hachures dessinées.
  function noriTextures(THREE, { W = 2048, H = 320, seed = 11, strokes = 1500 } = {}) {
    const n1 = makeNoise(seed);
    const rnd = mulberry32(seed + 1);
    const data = new Uint8ClampedArray(W * H * 4);
    const dark = rgb('#0a0d0c');
    const mid = rgb('#141917');
    const light = rgb('#212825');
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const t = 0.62 * fbm(n1, u * 8, v * 1.3, 4, 8, 0) + 0.38 * fbm(n1, u * 80 + 11, v * 12, 2, 80, 0);
        const c = t < 0.5 ? mix3(dark, mid, t / 0.5) : mix3(mid, light, ((t - 0.5) / 0.5) * 0.7);
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    }
    const cv = dataCanvas(W, H, data);
    const ctx = cv.getContext('2d');
    const hc = makeCanvas(W, H);
    const hx = hc.getContext('2d');
    hx.fillStyle = '#808080';
    hx.fillRect(0, 0, W, H);
    hx.filter = 'blur(1.4px)';
    const k = Math.max(0.6, W / 2048);
    for (let s = 0; s < strokes; s++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const a = rnd() * Math.PI;
      const len = (16 + rnd() * 64) * k;
      const bend = (rnd() - 0.5) * len * 0.6;
      const ex = Math.cos(a) * len;
      const ey = Math.sin(a) * len;
      const cxo = ex / 2 - Math.sin(a) * bend;
      const cyo = ey / 2 + Math.cos(a) * bend;
      const ridge = rnd() < 0.55;
      const lwH = 1.4 + rnd() * 3;
      const lwC = 0.8 + rnd() * 1.2;
      const colC = ridge ? `rgba(78, 92, 86, ${0.1 + rnd() * 0.18})` : `rgba(0, 0, 0, ${0.2 + rnd() * 0.2})`;
      const inside = x + Math.min(0, ex) > 0 && x + Math.max(0, ex) < W;
      for (const off of inside ? [0] : [0, -W, W]) {
        hx.strokeStyle = ridge ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
        hx.lineWidth = lwH;
        hx.beginPath();
        hx.moveTo(x + off, y);
        hx.quadraticCurveTo(x + off + cxo, y + cyo, x + off + ex, y + ey);
        hx.stroke();
        ctx.strokeStyle = colC;
        ctx.lineWidth = lwC;
        ctx.beginPath();
        ctx.moveTo(x + off, y);
        ctx.quadraticCurveTo(x + off + cxo, y + cyo, x + off + ex, y + ey);
        ctx.stroke();
      }
    }
    const hd = hx.getImageData(0, 0, W, H).data;
    const height = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) height[i] = hd[i * 4] / 255;
    const map = canvasTexture(THREE, cv, { wrap: true });
    const normal = canvasTexture(THREE, dataCanvas(W, H, heightToNormal(height, W, H, 3, true, false)), {
      srgb: false,
      wrap: true,
    });
    return { map, normal };
  }

  // Riz : grains dessinés (face coupée du grand maki, blocs des nigiri, côté
  // des uramaki avec sésame).
  function riceTexture(THREE, { W = 512, H = 512, size = 26, sesame = false, seed = 7, wrap = true, base = '#b9ad98' } = {}) {
    const cv = makeCanvas(W, H);
    const ctx = cv.getContext('2d');
    const rnd = mulberry32(seed);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    drawRice(ctx, rnd, [-size, -size, W + size, H + size], Math.round((W * H) / (size * size * 0.75)), size, 0.55);
    if (sesame) drawSesame(ctx, rnd, () => true, [0, 0, W, H], Math.round((W * H) / 2600), size * 0.35);
    return canvasTexture(THREE, cv, { wrap });
  }

  // Coupe du saumon du grand maki, dessinée dans le cadre de son contour.
  function salmonFaceTexture(THREE, outline) {
    const S = 1024;
    const cv = makeCanvas(S, S);
    const ctx = cv.getContext('2d');
    const rnd = mulberry32(9);
    const [x0, y0, x1, y1] = bbox(outline);
    const P = outline.map(([x, y]) => [((x - x0) / (x1 - x0)) * S, (1 - (y - y0) / (y1 - y0)) * S]);
    paintFish(ctx, P, [0, 0, S, S], rnd, 'saumon', { ink: 0, stripes: 5 });
    return canvasTexture(THREE, cv);
  }

  // Faces coupées dessinées des petites pièces du plateau.
  // kind : hoso-saumon | hoso-thon | hoso-concombre | ura | futo
  function faceTexture(THREE, kind, seed) {
    const S = 512;
    const C = S / 2;
    const rnd = mulberry32(seed);
    const nz = makeNoise(seed);
    const cv = makeCanvas(S, S);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#121514';
    ctx.fillRect(0, 0, S, S);
    const outer = wobblyRing(C, C, 252, 0.012, nz, 0.3);
    if (kind === 'ura') {
      // riz dehors (avec sésame), nori à l'intérieur, garniture California
      ctx.save();
      smoothClosed(ctx, outer, rnd, 0);
      ctx.clip();
      ctx.fillStyle = '#cfc3af';
      ctx.fillRect(0, 0, S, S);
      drawRice(ctx, rnd, [0, 0, S, S], 520, 24, 0.5);
      drawSesame(ctx, rnd, (x, y) => Math.hypot(x - C, y - C) > 165, [0, 0, S, S], 130, 9);
      ctx.fillStyle = '#121615';
      smoothClosed(ctx, wobblyRing(C, C, 152, 0.05, nz, 1.7), rnd, 0);
      ctx.fill();
      ctx.fillStyle = '#ddd3c3';
      smoothClosed(ctx, wobblyRing(C, C, 140, 0.05, nz, 2.9), rnd, 0);
      ctx.fill();
      paintAvocado(ctx, C - 6, C - 16, 92, 58, 0.12, rnd);
      paintBlock(ctx, C - 40, C + 54, 58, 26, -0.1, '#e9573d', '#f7f0ea', rnd, nz);
      paintCucumber(ctx, C + 64, C + 44, 36, rnd, nz);
      ctx.restore();
      inkLine(ctx, outer, rnd, 5);
    } else {
      const futo = kind === 'futo';
      const inner = wobblyRing(C, C, futo ? 238 : 234, 0.025, nz, 1.1);
      ctx.fillStyle = '#0f1312';
      smoothClosed(ctx, outer, rnd, 0);
      ctx.fill();
      ctx.save();
      smoothClosed(ctx, inner, rnd, 0);
      ctx.clip();
      ctx.fillStyle = '#cfc3af';
      ctx.fillRect(0, 0, S, S);
      drawRice(ctx, rnd, [0, 0, S, S], futo ? 560 : 470, futo ? 20 : 26, 0.5);
      ctx.restore();
      if (kind === 'hoso-concombre') {
        paintCucumber(ctx, C, C, 104, rnd, nz);
      } else if (futo) {
        paintFish(ctx, blobPoints(C - 58, C - 30, 54, 40, 3, 0.1, nz, 5.1), [C - 112, C - 70, C - 4, C + 10], rnd, 'saumon', {
          stripes: 3,
        });
        paintBlock(ctx, C + 50, C - 52, 58, 30, -0.08, null, '#f2c94c', rnd, nz);
        paintCucumber(ctx, C + 78, C + 36, 34, rnd, nz);
        paintAvocado(ctx, C - 10, C + 78, 70, 40, 0.06, rnd);
        paintBlock(ctx, C + 8, C + 10, 40, 22, 0.2, '#e9573d', '#f7f0ea', rnd, nz);
      } else {
        const fish = kind === 'hoso-thon' ? 'thon' : 'saumon';
        const P = blobPoints(C - 8, C + 4, 152, 138, 3, -0.1, nz, 7.3, 0.07);
        paintFish(ctx, P, [C - 160, C - 134, C + 144, C + 142], rnd, fish, { stripes: fish === 'saumon' ? 4 : 3 });
      }
      inkLine(ctx, inner, rnd, 3, 0.55);
      inkLine(ctx, outer, rnd, 5);
    }
    return canvasTexture(THREE, cv);
  }

  // Tranches de poisson (nigiri, sashimi) : la longueur suit la largeur de l'image.
  function fishTexture(THREE, kind, seed) {
    const W = 512;
    const H = 256;
    const cv = makeCanvas(W, H);
    const ctx = cv.getContext('2d');
    const rnd = mulberry32(seed);
    const P = [
      [-W, -H],
      [2 * W, -H],
      [2 * W, 2 * H],
      [-W, 2 * H],
    ];
    paintFish(ctx, P, [0, 0, W, H], rnd, kind, { ink: 0, stripes: kind === 'saumon' ? 7 : 5 });
    return canvasTexture(THREE, cv);
  }

  // Bois clair du plateau (geta), avec quelques traits de crayon dans le fil.
  function woodTexture(THREE) {
    const W = 1024;
    const H = 512;
    const n1 = makeNoise(31);
    const n2 = makeNoise(32);
    const data = new Uint8ClampedArray(W * H * 4);
    const base = rgb('#c9a271');
    const lineC = rgb('#966a3e');
    const hi = rgb('#dbb886');
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const t = v * 26 + fbm(n1, u * 2, v * 6, 4) * 5;
        const band = Math.abs((t % 1) - 0.5) * 2;
        const grain = Math.pow(clamp(1 - band / 0.2, 0, 1), 2);
        const fine = fbm(n2, u * 50, v * 240, 2);
        let c = mix3(base, hi, clamp((fbm(n1, u * 3 + 9, v * 3, 3) - 0.45) * 1.6, 0, 1) * 0.5);
        c = mix3(c, lineC, grain * 0.5);
        c = mix3(c, lineC, (fine - 0.5) * 0.35 + 0.04);
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    }
    const cv = dataCanvas(W, H, data);
    const ctx = cv.getContext('2d');
    const rnd = mulberry32(33);
    for (let i = 0; i < 26; i++) {
      const y = rnd() * H;
      ctx.strokeStyle = `rgba(120, 82, 46, ${0.15 + rnd() * 0.2})`;
      ctx.lineWidth = 0.8 + rnd() * 1.6;
      ctx.beginPath();
      ctx.moveTo(-10, y);
      for (let x = 0; x <= W + 40; x += 40) ctx.lineTo(x, y + Math.sin(x * 0.01 + i) * 6 + (rnd() - 0.5) * 3);
      ctx.stroke();
    }
    return canvasTexture(THREE, cv);
  }

  // Table en noyer foncé (texture raccordable, répétée).
  function walnutTexture(THREE) {
    const W = 1024;
    const H = 1024;
    const n1 = makeNoise(57);
    const n2 = makeNoise(58);
    const data = new Uint8ClampedArray(W * H * 4);
    const base = rgb('#3a2517');
    const lineC = rgb('#1f130b');
    const hi = rgb('#52341f');
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const t = v * 22 + fbm(n1, u * 2, v * 4, 4, 2, 4) * 7;
        const band = Math.abs((t % 1) - 0.5) * 2;
        const grain = Math.pow(clamp(1 - band / 0.18, 0, 1), 2);
        const fine = fbm(n2, u * 32, v * 256, 2, 32, 256);
        const patch = fbm(n1, u * 3 + 9, v * 3, 3, 3, 3);
        let c = mix3(base, hi, clamp((patch - 0.45) * 1.6, 0, 1) * 0.6);
        c = mix3(c, lineC, grain * 0.75);
        c = mix3(c, lineC, (fine - 0.5) * 0.5 + 0.05);
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    }
    return canvasTexture(THREE, dataCanvas(W, H, data), { wrap: true });
  }

  // Ardoise : gris anthracite, fines strates, grain minéral.
  function slateTextures(THREE) {
    const W = 1024;
    const H = 768;
    const n1 = makeNoise(61);
    const n2 = makeNoise(62);
    const color = new Uint8ClampedArray(W * H * 4);
    const height = new Float32Array(W * H);
    const a = rgb('#1b1c1d');
    const b = rgb('#2e2f31');
    const c3 = rgb('#3c3c3b');
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const strata = fbm(n1, u * 1.5, v * 14, 4);
        const grain = fbm(n2, u * 140, v * 110, 2);
        const patch = fbm(n1, u * 4 + 7, v * 3, 3);
        let col = mix3(a, b, clamp(strata * 1.3 - 0.2, 0, 1));
        col = mix3(col, c3, clamp((patch - 0.55) * 2.2, 0, 1) * 0.5);
        col = mix3(col, a, (grain - 0.5) * 0.6 + 0.1);
        const i = (y * W + x) * 4;
        color[i] = col[0];
        color[i + 1] = col[1];
        color[i + 2] = col[2];
        color[i + 3] = 255;
        height[y * W + x] = grain * 0.6 + strata * 0.4;
      }
    }
    const map = canvasTexture(THREE, dataCanvas(W, H, color));
    const normal = canvasTexture(THREE, dataCanvas(W, H, heightToNormal(height, W, H, 1.6, false, false)), { srgb: false });
    return { map, normal };
  }

  function chopstickTexture(THREE) {
    const W = 64;
    const H = 512;
    const n = makeNoise(5);
    const data = new Uint8ClampedArray(W * H * 4);
    const a = rgb('#c9a273');
    const b = rgb('#a77f52');
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = fbm(n, x / 6, y / 90, 3, W / 6, 0);
        const c = mix3(a, b, clamp((t - 0.35) * 1.4, 0, 1));
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    }
    return canvasTexture(THREE, dataCanvas(W, H, data), { wrap: true });
  }

  /* ------------------------------------------------------------------ maki */

  // Hosomaki au saumon, d'après la photo de référence : gros cœur de saumon
  // (~65 % du diamètre), anneau de riz assez fin, nori presque noir. Contours
  // volontairement irréguliers, comme roulé et dessiné à la main.
  const MAKI = { R: 2.45, H: 2.6, NT: 0.055 };
  const shapeNoise = makeNoise(314);

  function makiRadius(theta) {
    const u = (((theta / (Math.PI * 2)) % 1) + 1) % 1;
    return (
      MAKI.R *
      (1 + 0.02 * Math.sin(2 * theta + 0.7) + 0.01 * Math.sin(3 * theta + 2.1) + 0.03 * (shapeNoise(u * 7, 0.5, 7) - 0.5))
    );
  }

  // Contour du saumon : carré arrondi un peu de travers, légèrement à gauche.
  const SALMON = { x: -0.18, y: 0.02, a: 1.6, b: 1.47, n: 3.0, rot: -0.1 };
  function salmonPoint(t) {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const k = 2 / SALMON.n;
    const u = (((t / (Math.PI * 2)) % 1) + 1) % 1;
    const wob = 1 + 0.07 * (shapeNoise(u * 9, 3.3, 9) - 0.5) + 0.018 * Math.sin(3 * t + 1);
    const x = SALMON.a * Math.sign(c) * Math.pow(Math.abs(c), k) * wob;
    const y = SALMON.b * Math.sign(s) * Math.pow(Math.abs(s), k) * wob;
    const cr = Math.cos(SALMON.rot);
    const sr = Math.sin(SALMON.rot);
    return [SALMON.x + x * cr - y * sr, SALMON.y + x * sr + y * cr];
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Disque dont le bord suit un contour irrégulier (rayon selon l'angle).
  function irregularDisc(THREE, radiusFn, segments, shrink = 0) {
    const g = new THREE.CircleGeometry(1, segments);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      if (Math.hypot(x, y) < 1e-6) continue;
      const r = radiusFn(Math.atan2(y, x)) - shrink;
      p.setXY(i, x * r, y * r);
    }
    return g;
  }

  function buildMakiAssets(THREE) {
    const { R, H, NT } = MAKI;
    const nori = noriTextures(THREE);
    const outline = [];
    for (let i = 0; i < 120; i++) outline.push(salmonPoint((i / 120) * Math.PI * 2));
    const mats = {
      nori: inkify(
        new THREE.MeshPhysicalMaterial({
          map: nori.map,
          normalMap: nori.normal,
          normalScale: new THREE.Vector2(0.9, 0.9),
          roughness: 0.4,
          sheen: 0.55,
          sheenRoughness: 0.35,
          sheenColor: new THREE.Color('#7f8b86'),
          clearcoat: 0.18,
          clearcoatRoughness: 0.45,
        }),
        { width: 0.24, strength: 0.7, wobble: 0.012 }
      ),
      noriEdge: new THREE.MeshStandardMaterial({ color: '#0b0d0c', roughness: 0.7, side: THREE.DoubleSide }),
      riceCap: new THREE.MeshStandardMaterial({
        map: riceTexture(THREE, { W: 1024, H: 1024, size: 50, seed: 42, wrap: false, base: '#cbc0ad' }),
        roughness: 0.8,
        side: THREE.DoubleSide,
      }),
      // Riz en aplats (trois tons), comme peint. Le matériau « toon » ignore
      // l'éclairage d'ambiance : une pointe d'émissif garde le riz bien blanc.
      grain: inkify(
        new THREE.MeshToonMaterial({ color: '#f8f4ec', emissive: '#6b665e', gradientMap: toneRamp(THREE, [0.6, 0.84, 1]) }),
        { width: 0.3, strength: 0.25, wobble: 0.008, scale: 9 }
      ),
      hull: inkHullMaterial(THREE, { width: 2.4, vary: 1.1, scale: 1.4 }),
      // les grains sont cernés d'un trait plus clair, pour que le riz reste blanc
      grainHull: inkHullMaterial(THREE, { width: 0.9, vary: 0.9, scale: 5, color: '#a08b76' }),
      salmon: inkify(
        new THREE.MeshPhysicalMaterial({
          map: salmonFaceTexture(THREE, outline),
          roughness: 0.3,
          clearcoat: 0.5,
          clearcoatRoughness: 0.3,
          sheen: 0.25,
          sheenColor: new THREE.Color('#ffb48f'),
        }),
        { width: 0.32, strength: 0.75, wobble: 0.01 }
      ),
    };

    // Nori (côté) : contour irrégulier, léger ventre, bords un peu ondulés.
    const side = new THREE.CylinderGeometry(1, 1, H, 192, 14, true);
    side.rotateX(Math.PI / 2);
    const rimNoise = makeNoise(8);
    const p = side.attributes.position;
    const nrm = side.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      let z = p.getZ(i);
      const a = Math.atan2(y, x);
      const u = (a / (Math.PI * 2) + 1) % 1;
      const zn = z / (H / 2);
      const r = makiRadius(a) * (1 + 0.014 * (1 - zn * zn));
      if (Math.abs(zn) > 0.999) z += (rimNoise(u * 11, zn > 0 ? 1.3 : 6.1, 11) - 0.5) * 0.07;
      const l = Math.hypot(x, y);
      p.setXYZ(i, (x / l) * r, (y / l) * r, z);
      nrm.setXYZ(i, x / l, y / l, 0);
    }
    // Tranche de la feuille de nori sur chaque face.
    const edge = new THREE.RingGeometry(1 - NT / R, 1.004, 192, 1);
    const ep = edge.attributes.position;
    for (let i = 0; i < ep.count; i++) {
      const x = ep.getX(i);
      const y = ep.getY(i);
      const k = makiRadius(Math.atan2(y, x));
      ep.setXY(i, x * k, y * k);
    }
    const cap = irregularDisc(THREE, makiRadius, 160, NT * 0.8);

    // Saumon : prisme au contour irrégulier, un peu en relief sur les faces.
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const depth = H + 0.08;
    const salmon = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.035,
      bevelSegments: 3,
    });
    salmon.translate(0, 0, -depth / 2);
    const [sx0, sy0, sx1, sy1] = bbox(outline);
    const sp = salmon.attributes.position;
    const suv = salmon.attributes.uv;
    for (let i = 0; i < sp.count; i++) {
      suv.setXY(i, clamp((sp.getX(i) - sx0) / (sx1 - sx0), 0, 1), clamp((sp.getY(i) - sy0) / (sy1 - sy0), 0, 1));
    }

    // Grains de riz en relief entre le saumon et le nori, sur les deux faces,
    // plus quelques grains égarés sur le bord du saumon.
    const grainGeo = new THREE.SphereGeometry(1, 12, 9);
    const rnd = mulberry32(2024);
    const grow = (f) => outline.map(([x, y]) => [SALMON.x + (x - SALMON.x) * f, SALMON.y + (y - SALMON.y) * f]);
    const outer = grow(1.07);
    const placed = [];
    const minD = 0.16;
    let tries = 0;
    while (placed.length < 190 && tries < 60000) {
      tries++;
      const th = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * (makiRadius(th) - NT - 0.24);
      const x = Math.cos(th) * rr;
      const y = Math.sin(th) * rr;
      if (pointInPoly(x, y, outer)) continue;
      let ok = true;
      for (let j = 0; j < placed.length; j++) {
        const q = placed[j];
        if ((q[0] - x) * (q[0] - x) + (q[1] - y) * (q[1] - y) < minD * minD) {
          ok = false;
          break;
        }
      }
      if (ok) placed.push([x, y]);
    }
    const strays = grow(0.93);
    const grains = [];
    for (const face of [1, -1]) {
      for (const [x, y] of placed) {
        grains.push({
          x: x + (rnd() - 0.5) * 0.05,
          y: y + (rnd() - 0.5) * 0.05,
          z: face * (H / 2 + 0.012 + rnd() * 0.035),
          rx: (rnd() - 0.5) * 0.6,
          ry: (rnd() - 0.5) * 0.4,
          rz: rnd() * Math.PI,
          s: 0.78 + rnd() * 0.47,
          c: 0.92 + rnd() * 0.08,
        });
      }
      for (let k = 0; k < 5; k++) {
        const [x, y] = strays[(rnd() * strays.length) | 0];
        grains.push({ x, y, z: face * (H / 2 + 0.1), rx: (rnd() - 0.5) * 0.4, ry: 0, rz: rnd() * Math.PI, s: 0.9, c: 0.97 });
      }
    }

    // Traits d'encre : coque du rouleau entier, contours du saumon et du bord
    // intérieur de la feuille de nori sur chaque face.
    const ring = [];
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      const r = makiRadius(a);
      ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const hull = hullPrism(THREE, ring, 0, 0, H, 0.1);
    const noriInner = ring.map(([x, y]) => {
      const l = Math.hypot(x, y);
      return [x * (1 - NT / l), y * (1 - NT / l)];
    });

    return {
      mats,
      geos: { side, edge, cap, salmon, grain: grainGeo, hull },
      rings: { salmon: outline, nori: noriInner, salmonZ: depth / 2 + 0.04 },
      grains,
    };
  }

  function buildMaki(THREE, assets) {
    const { H } = MAKI;
    const { mats, geos, grains, rings } = assets;
    const g = new THREE.Group();
    g.name = 'maki';

    const side = new THREE.Mesh(geos.side, mats.nori);
    side.castShadow = true;
    side.receiveShadow = true;
    g.add(side);
    g.add(new THREE.Mesh(geos.hull, mats.hull));

    // Traits à plat sur les deux faces : deux passes pour le saumon (un trait
    // franc et un plus fin, décalé), une pour le bord du nori.
    for (const face of [1, -1]) {
      g.add(inkRibbon(THREE, rings.salmon, face * (rings.salmonZ + 0.006), { width: 0.075, offset: 0.03, seed: face * 3 }));
      g.add(
        inkRibbon(THREE, rings.salmon, face * (rings.salmonZ + 0.008), {
          width: 0.03,
          offset: -0.035,
          seed: face * 3 + 11,
          wander: 0.03,
        })
      );
      g.add(inkRibbon(THREE, rings.nori, face * (H / 2 + 0.008), { width: 0.06, offset: 0.004, seed: face * 5 + 2 }));
    }

    // Faces : mêmes géométries des deux côtés (matériaux double face) pour que
    // le contour irrégulier corresponde partout au côté en nori.
    for (const face of [1, -1]) {
      const edge = new THREE.Mesh(geos.edge, mats.noriEdge);
      edge.position.z = face * (H / 2 + 0.003);
      g.add(edge);
      const cap = new THREE.Mesh(geos.cap, mats.riceCap);
      cap.position.z = face * (H / 2 - 0.004);
      cap.receiveShadow = true;
      g.add(cap);
    }

    const salmon = new THREE.Mesh(geos.salmon, mats.salmon);
    salmon.castShadow = true;
    salmon.receiveShadow = true;
    g.add(salmon);

    const inst = new THREE.InstancedMesh(geos.grain, mats.grain, grains.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const col = new THREE.Color();
    grains.forEach((gr, i) => {
      e.set(gr.rx, gr.ry, gr.rz, 'ZXY');
      q.setFromEuler(e);
      sc.set(0.25 * gr.s, 0.135 * gr.s, 0.09 * gr.s);
      pos.set(gr.x, gr.y, gr.z);
      m.compose(pos, q, sc);
      inst.setMatrixAt(i, m);
      col.setRGB(gr.c, gr.c * 0.995, gr.c * 0.985);
      inst.setColorAt(i, col);
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    g.add(inst);
    // chaque grain cerné d'un trait
    const instHull = new THREE.InstancedMesh(geos.grain, mats.grainHull, grains.length);
    instHull.instanceMatrix = inst.instanceMatrix;
    g.add(instHull);
    return g;
  }

  /* ------------------------------------------------- plan de travail (intro) */

  function buildSet(THREE, RoundedBoxGeometry) {
    const set = new THREE.Group();
    set.name = 'set';
    const fade = []; // matériaux à estomper au scroll
    const own = (mat) => {
      mat.transparent = true;
      fade.push(mat);
      return mat;
    };
    const rnd = mulberry32(99);
    const BOARD_TOP = 1.1;

    // Table en noyer.
    const walnut = walnutTexture(THREE);
    walnut.repeat.set(6.5, 4);
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 160),
      own(new THREE.MeshPhysicalMaterial({ map: walnut, roughness: 0.6, clearcoat: 0.12, clearcoatRoughness: 0.6 }))
    );
    table.receiveShadow = true;
    set.add(table);

    // Plateau en ardoise.
    const slate = slateTextures(THREE);
    const board = new THREE.Mesh(
      new RoundedBoxGeometry(36, 30, BOARD_TOP, 3, 0.3),
      own(
        new THREE.MeshPhysicalMaterial({
          map: slate.map,
          normalMap: slate.normal,
          normalScale: new THREE.Vector2(0.6, 0.6),
          roughness: 0.78,
          clearcoat: 0.12,
          clearcoatRoughness: 0.55,
        })
      )
    );
    board.position.set(9.6, 4.6, BOARD_TOP / 2);
    board.rotation.z = THREE.MathUtils.degToRad(-4);
    board.castShadow = true;
    board.receiveShadow = true;
    set.add(board);

    // Makisu (natte en bambou) en haut à gauche.
    const slatGeo = new THREE.CylinderGeometry(0.21, 0.21, 24, 10);
    slatGeo.rotateZ(Math.PI / 2);
    const slatCount = 52;
    const slats = new THREE.InstancedMesh(
      slatGeo,
      own(new THREE.MeshStandardMaterial({ color: '#dcc391', roughness: 0.55 })),
      slatCount
    );
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let i = 0; i < slatCount; i++) {
      m.makeTranslation((rnd() - 0.5) * 0.12, i * 0.47 - (slatCount * 0.47) / 2, 0.21);
      slats.setMatrixAt(i, m);
      col.setHSL(0.11 + (rnd() - 0.5) * 0.015, 0.42 + rnd() * 0.12, 0.62 + (rnd() - 0.5) * 0.08);
      slats.setColorAt(i, col);
    }
    slats.castShadow = true;
    slats.receiveShadow = true;
    const makisu = new THREE.Group();
    makisu.add(slats);
    const stringMat = own(new THREE.MeshStandardMaterial({ color: '#ece4d2', roughness: 0.95 }));
    for (const sx of [-9.2, -3.2, 3.2, 9.2]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, slatCount * 0.47, 6), stringMat);
      s.position.set(sx, 0, 0.42);
      s.castShadow = true;
      makisu.add(s);
    }
    makisu.position.set(-22.5, 11.5, 0);
    makisu.rotation.z = 0.12;
    set.add(makisu);

    // Baguettes posées sur un repose-baguettes en céramique.
    const stickTex = chopstickTexture(THREE);
    const stickMat = own(new THREE.MeshStandardMaterial({ map: stickTex, roughness: 0.5 }));
    const restMat = own(new THREE.MeshPhysicalMaterial({ color: '#ebe4d8', roughness: 0.3, clearcoat: 0.7 }));
    const rest = new THREE.Mesh(new RoundedBoxGeometry(2.8, 1.15, 0.95, 3, 0.42), restMat);
    rest.position.set(8.1, 3.6, BOARD_TOP + 0.47);
    rest.rotation.z = -0.98 + Math.PI / 2;
    rest.castShadow = true;
    rest.receiveShadow = true;
    set.add(rest);
    const STICK_L = 23;
    const sticks = [
      [-0.55, 0],
      [0.62, -0.9],
    ].map(([off, slide]) => {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.34, STICK_L, 12), stickMat);
      stick.castShadow = true;
      stick.userData = { off, slide };
      set.add(stick);
      return stick;
    });
    // Pose les baguettes : pointes près de (tx, ty), dans la direction (dx, dy).
    const UP = new THREE.Vector3(0, 1, 0);
    function placeChopsticks(tx, ty, dx, dy) {
      const dir = new THREE.Vector3(dx, dy, 0).normalize();
      const perp = new THREE.Vector3(-dir.y, dir.x, 0);
      rest.position.set(tx - dir.x * 2.45, ty - dir.y * 2.45, BOARD_TOP + 0.47);
      rest.rotation.z = Math.atan2(dir.y, dir.x) + Math.PI / 2;
      for (const stick of sticks) {
        const { off, slide } = stick.userData;
        // axe Y du cylindre → direction des baguettes (pointe = +Y)
        stick.quaternion.setFromUnitVectors(UP, dir);
        const tip = new THREE.Vector3(tx, ty, 0).addScaledVector(perp, off).addScaledVector(dir, slide);
        stick.position.copy(tip).addScaledVector(dir, -STICK_L / 2);
        stick.position.z = BOARD_TOP + 0.75;
        // légère inclinaison : la pointe repose sur le repose-baguettes
        stick.rotateOnWorldAxis(perp, -0.035);
      }
    }

    // Couteau (yanagiba) en bas à droite.
    const knife = new THREE.Group();
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0, 1.6);
    bladeShape.lineTo(20.5, 1.6);
    bladeShape.quadraticCurveTo(23.6, 1.55, 24.3, 1.15);
    bladeShape.quadraticCurveTo(22.6, -0.7, 18.8, -1.45);
    bladeShape.lineTo(0, -1.55);
    bladeShape.lineTo(0, 1.6);
    const bt = bladeTextures(THREE);
    const blade = new THREE.Mesh(
      new THREE.ExtrudeGeometry(bladeShape, {
        depth: 0.18,
        bevelEnabled: true,
        bevelThickness: 0.06,
        bevelSize: 0.08,
        bevelSegments: 3,
        curveSegments: 24,
      }),
      own(new THREE.MeshPhysicalMaterial({ map: bt.map, roughnessMap: bt.rough, metalness: 1, roughness: 1 }))
    );
    blade.castShadow = true;
    blade.receiveShadow = true;
    knife.add(blade);
    const ferrule = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.2, 2.2, 8),
      own(new THREE.MeshPhysicalMaterial({ color: '#141010', roughness: 0.3, clearcoat: 0.8 }))
    );
    ferrule.rotation.z = Math.PI / 2;
    ferrule.position.set(-1.1, 0, 0.12);
    ferrule.castShadow = true;
    knife.add(ferrule);
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.08, 13, 8),
      own(new THREE.MeshStandardMaterial({ color: '#d9c49b', roughness: 0.6 }))
    );
    handle.rotation.z = Math.PI / 2;
    handle.position.set(-8.7, 0, 0.12);
    handle.castShadow = true;
    knife.add(handle);
    // Pointe vers le haut à gauche ; léger basculement : le manche repose sur
    // la planche et la pointe l'effleure.
    knife.rotation.set(0, 0.029, Math.atan2(0.5, -0.86), 'ZYX');
    set.add(knife);

    // Coupelle de sauce soja en bas à gauche, sur la table.
    const prof = [
      [0, 0],
      [3.0, 0],
      [3.32, 0.08],
      [3.78, 0.46],
      [3.98, 0.96],
      [3.9, 1.04],
      [3.62, 0.66],
      [3.15, 0.38],
      [0, 0.34],
    ].map(([r, h]) => new THREE.Vector2(r, h));
    const dishGeo = new THREE.LatheGeometry(prof, 96);
    dishGeo.rotateX(Math.PI / 2);
    const dish = new THREE.Mesh(
      dishGeo,
      own(new THREE.MeshPhysicalMaterial({ color: '#ece5d9', roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.2 }))
    );
    dish.castShadow = true;
    dish.receiveShadow = true;
    const soy = new THREE.Mesh(
      new THREE.CircleGeometry(3.1, 96),
      own(new THREE.MeshPhysicalMaterial({ color: '#241005', roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04 }))
    );
    soy.position.z = 0.5;
    const dishG = new THREE.Group();
    dishG.add(dish, soy);
    set.add(dishG);

    // Deux compositions : en paysage, le décor s'étale autour du maki ; en
    // portrait (téléphone), on resserre tout dans la bande visible pour qu'on
    // reconnaisse la natte, les baguettes et la sauce soja.
    set.userData.layout = (portrait) => {
      if (portrait) {
        board.position.set(6, 0.5, BOARD_TOP / 2);
        placeChopsticks(3.9, 3.4, -0.25, -0.97);
        dishG.position.set(-6.9, -0.7, BOARD_TOP);
        // la natte (claire) et le couteau passeraient sous les textes
        makisu.visible = false;
        knife.visible = false;
      } else {
        makisu.visible = true;
        knife.visible = true;
        board.position.set(9.6, 4.6, BOARD_TOP / 2);
        makisu.position.set(-22.5, 11.5, 0);
        makisu.rotation.z = 0.12;
        placeChopsticks(9.3, 1.5, 0.56, -0.83);
        dishG.position.set(-12.4, -6.9, 0);
        knife.position.set(28, -15.3, BOARD_TOP + 0.78);
      }
    };
    set.userData.layout(false);

    // Graines de sésame et quelques grains de riz égarés.
    const seedGeo = new THREE.SphereGeometry(1, 8, 6);
    const SEEDS = 11;
    const seeds = new THREE.InstancedMesh(
      seedGeo,
      own(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 })),
      SEEDS
    );
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (let i = 0; i < SEEDS; i++) {
      const a = 2.2 + rnd() * 3.2;
      const r = 3.2 + Math.pow(rnd(), 1.4) * 3.2;
      pos.set(Math.cos(a) * r, Math.sin(a) * r * 0.8, BOARD_TOP + 0.05);
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * Math.PI);
      sc.set(0.17, 0.1, 0.05);
      m.compose(pos, q, sc);
      seeds.setMatrixAt(i, m);
      seeds.setColorAt(i, col.set(rnd() < 0.22 ? '#1d1713' : '#efdfbe'));
    }
    seeds.castShadow = true;
    set.add(seeds);
    set.userData.fade = fade;
    set.userData.boardTop = BOARD_TOP;
    return set;
  }

  /* ------------------------------------------------------------------ main */

  // Subdivision de Loop d'un maillage skinné : positions lissées, poids de
  // skinning mélangés (4 influences max). Fusionne d'abord les sommets
  // dupliqués par les coutures UV.
  function subdivideSkinned(THREE, geometry, iterations) {
    const srcPos = geometry.attributes.position.array;
    const srcSi = geometry.attributes.skinIndex.array;
    const srcSw = geometry.attributes.skinWeight.array;
    const srcIdx = geometry.index.array;
    const map = new Map();
    const remap = new Uint32Array(srcPos.length / 3);
    let pos = [];
    let si = [];
    let sw = [];
    for (let i = 0; i < srcPos.length / 3; i++) {
      const k =
        Math.round(srcPos[3 * i] * 1e5) + ',' + Math.round(srcPos[3 * i + 1] * 1e5) + ',' + Math.round(srcPos[3 * i + 2] * 1e5);
      let id = map.get(k);
      if (id === undefined) {
        id = pos.length / 3;
        map.set(k, id);
        pos.push(srcPos[3 * i], srcPos[3 * i + 1], srcPos[3 * i + 2]);
        for (let j = 0; j < 4; j++) {
          si.push(srcSi[4 * i + j]);
          sw.push(srcSw[4 * i + j]);
        }
      }
      remap[i] = id;
    }
    let idx = [];
    for (let t = 0; t < srcIdx.length; t += 3) {
      const a = remap[srcIdx[t]];
      const b = remap[srcIdx[t + 1]];
      const c = remap[srcIdx[t + 2]];
      if (a !== b && b !== c && a !== c) idx.push(a, b, c);
    }
    for (let it = 0; it < iterations; it++) ({ pos, si, sw, idx } = loopStep(pos, si, sw, idx));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(Array.from(idx));
    g.computeVertexNormals();
    return g;
  }

  function loopStep(pos, si, sw, idx) {
    const nV = pos.length / 3;
    const nT = idx.length / 3;
    const edgeOf = new Map();
    const eA = [];
    const eB = [];
    const eO1 = [];
    const eO2 = [];
    const triE = new Int32Array(nT * 3);
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const a = idx[3 * t + k];
        const b = idx[3 * t + ((k + 1) % 3)];
        const c = idx[3 * t + ((k + 2) % 3)];
        const key = a < b ? a * 1048576 + b : b * 1048576 + a;
        let e = edgeOf.get(key);
        if (e === undefined) {
          e = eA.length;
          edgeOf.set(key, e);
          eA.push(a);
          eB.push(b);
          eO1.push(c);
          eO2.push(-1);
        } else if (eO2[e] === -1) {
          eO2[e] = c;
        }
        triE[3 * t + k] = e;
      }
    }
    const nE = eA.length;
    const nbr = Array.from({ length: nV }, () => []);
    const bnd = Array.from({ length: nV }, () => []);
    for (let e = 0; e < nE; e++) {
      nbr[eA[e]].push(eB[e]);
      nbr[eB[e]].push(eA[e]);
      if (eO2[e] === -1) {
        bnd[eA[e]].push(eB[e]);
        bnd[eB[e]].push(eA[e]);
      }
    }
    const N = nV + nE;
    const oPos = new Float32Array(N * 3);
    const oSi = new Uint16Array(N * 4);
    const oSw = new Float32Array(N * 4);
    for (let v = 0; v < nV; v++) {
      let x = pos[3 * v];
      let y = pos[3 * v + 1];
      let z = pos[3 * v + 2];
      if (bnd[v].length === 2) {
        const a = bnd[v][0];
        const b = bnd[v][1];
        x = 0.75 * x + 0.125 * (pos[3 * a] + pos[3 * b]);
        y = 0.75 * y + 0.125 * (pos[3 * a + 1] + pos[3 * b + 1]);
        z = 0.75 * z + 0.125 * (pos[3 * a + 2] + pos[3 * b + 2]);
      } else if (bnd[v].length === 0 && nbr[v].length >= 3) {
        const n = nbr[v].length;
        const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const u of nbr[v]) {
          sx += pos[3 * u];
          sy += pos[3 * u + 1];
          sz += pos[3 * u + 2];
        }
        x = (1 - n * beta) * x + beta * sx;
        y = (1 - n * beta) * y + beta * sy;
        z = (1 - n * beta) * z + beta * sz;
      }
      oPos[3 * v] = x;
      oPos[3 * v + 1] = y;
      oPos[3 * v + 2] = z;
      for (let k = 0; k < 4; k++) {
        oSi[4 * v + k] = si[4 * v + k];
        oSw[4 * v + k] = sw[4 * v + k];
      }
    }
    const acc = new Map();
    const blend = (o, list) => {
      acc.clear();
      for (let l = 0; l < list.length; l += 2) {
        const v = list[l];
        const w = list[l + 1];
        for (let k = 0; k < 4; k++) {
          const wt = sw[4 * v + k] * w;
          if (wt > 1e-6) {
            const j = si[4 * v + k];
            acc.set(j, (acc.get(j) || 0) + wt);
          }
        }
      }
      const arr = Array.from(acc.entries()).sort((p, q) => q[1] - p[1]).slice(0, 4);
      let sum = 0;
      for (const it of arr) sum += it[1];
      for (let k = 0; k < 4; k++) {
        oSi[4 * o + k] = arr[k] ? arr[k][0] : 0;
        oSw[4 * o + k] = arr[k] ? arr[k][1] / sum : 0;
      }
    };
    for (let e = 0; e < nE; e++) {
      const a = eA[e];
      const b = eB[e];
      const c = eO1[e];
      const d = eO2[e];
      const o = nV + e;
      if (d === -1) {
        for (let k = 0; k < 3; k++) oPos[3 * o + k] = 0.5 * (pos[3 * a + k] + pos[3 * b + k]);
        blend(o, [a, 0.5, b, 0.5]);
      } else {
        for (let k = 0; k < 3; k++) {
          oPos[3 * o + k] = 0.375 * (pos[3 * a + k] + pos[3 * b + k]) + 0.125 * (pos[3 * c + k] + pos[3 * d + k]);
        }
        blend(o, [a, 0.375, b, 0.375, c, 0.125, d, 0.125]);
      }
    }
    const oIdx = new Uint32Array(nT * 12);
    for (let t = 0; t < nT; t++) {
      const a = idx[3 * t];
      const b = idx[3 * t + 1];
      const c = idx[3 * t + 2];
      const ab = nV + triE[3 * t];
      const bc = nV + triE[3 * t + 1];
      const ca = nV + triE[3 * t + 2];
      oIdx.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], 12 * t);
    }
    return { pos: oPos, si: oSi, sw: oSw, idx: oIdx };
  }

  const JOINTS = {
    thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  };
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    JOINTS[f] = [
      `${f}-finger-metacarpal`,
      `${f}-finger-phalanx-proximal`,
      `${f}-finger-phalanx-intermediate`,
      `${f}-finger-phalanx-distal`,
      `${f}-finger-tip`,
    ];
  }

  // Pose « tenir des baguettes » (degrés), obtenue par cinématique inverse sur
  // les points de contact : pouce et index pincent la baguette du haut, le
  // majeur la soutient, l'annulaire porte celle du bas. Pour chaque
  // articulation : [flexion, écartement, torsion]. Index 0 = métacarpe.
  const GRIP = {
    thumb: [[24.6, -21.4, 7.6], [11.6, 0, 0], [10.7, 0, 0]],
    index: [[0, 0, 0], [-3.1, -8.8, 0], [55.4, 0, 0], [36.6, 0, 0]],
    middle: [[0, 0, 0], [2.7, 3.5, 0], [64.4, 0, 0], [42.5, 0, 0]],
    ring: [[0, 0, 0], [8.4, 12, 0], [66.8, 0, 0], [44.1, 0, 0]],
    pinky: [[0, 0, 0], [18.4, 16, 0], [74.8, 0, 0], [50.1, 0, 0]],
  };

  // Baguettes dans l'espace de la main (cm) : point d'appui au creux du pouce
  // et direction. Le maki est pincé à HOLD (centre, axe du cylindre).
  const STICKS = {
    U: { p: [2.2, -2.6, -2.7], d: [-0.367, -0.864, 0.345], back: 6.5, pivot: 3.5 },
    L: { p: [1.6, -1.9, -2.2], d: [-0.37, -0.798, 0.477], back: 6 },
  };
  const HOLD = { center: [-3.43, -14.27, 3.5], n: [0.9, -0.209, 0.383] };
  const HAND_SCALE = 1.5; // la main est agrandie pour que le maki y paraisse à l'échelle

  async function loadHand(THREE, GLTFLoader, opts = {}) {
    const gltf = await new GLTFLoader().loadAsync(opts.url || HAND_URL);
    const root = gltf.scene;
    const skinned = root.getObjectByProperty('type', 'SkinnedMesh');
    skinned.geometry = subdivideSkinned(THREE, skinned.geometry, opts.subdiv ?? 2);
    skinned.frustumCulled = false;
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    skinned.material = new THREE.MeshPhysicalMaterial({
      color: opts.skin || '#6a4330',
      roughness: 0.6,
      sheen: 0.8,
      sheenRoughness: 0.45,
      sheenColor: new THREE.Color('#d9936a'),
      clearcoat: 0.06,
      clearcoatRoughness: 0.5,
    });
    const bones = {};
    const rest = {};
    for (const chain of Object.values(JOINTS)) {
      for (const n of chain) {
        bones[n] = root.getObjectByName(n);
        rest[n] = { p: bones[n].position.clone(), q: bones[n].quaternion.clone() };
      }
    }
    const DEG = Math.PI / 180;
    const ax = new THREE.Vector3(1, 0, 0);
    const ay = new THREE.Vector3(0, 1, 0);
    const az = new THREE.Vector3(0, 0, 1);
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    const qc = new THREE.Quaternion();
    const tmpQ = new THREE.Quaternion();
    const tmpV = new THREE.Vector3();

    // Cinématique directe : chaque phalange garde son décalage au repos dans
    // le repère de la précédente, puis on applique flexion / écartement / torsion.
    function applyPose(pose) {
      for (const f of Object.keys(JOINTS)) {
        const chain = JOINTS[f];
        const angles = pose[f] || [];
        let pP = null;
        let pQ = null;
        for (let i = 0; i < chain.length; i++) {
          const n = chain[i];
          const r = rest[n];
          let p;
          let q;
          if (i === 0) {
            p = r.p.clone();
            q = r.q.clone();
          } else {
            const rp = rest[chain[i - 1]];
            tmpQ.copy(rp.q).invert();
            tmpV.copy(r.p).sub(rp.p).applyQuaternion(tmpQ);
            p = pP.clone().add(tmpV.applyQuaternion(pQ));
            q = pQ.clone().multiply(tmpQ.multiply(r.q));
          }
          const a = angles[i];
          if (a) {
            qa.setFromAxisAngle(ax, -(a[0] || 0) * DEG);
            qb.setFromAxisAngle(ay, (a[1] || 0) * DEG);
            qc.setFromAxisAngle(az, (a[2] || 0) * DEG);
            q.multiply(qb).multiply(qa).multiply(qc);
          }
          bones[n].position.copy(p);
          bones[n].quaternion.copy(q);
          pP = p;
          pQ = q;
        }
      }
      root.updateMatrixWorld(true);
    }

    const handSpace = new THREE.Group(); // mètres → centimètres
    handSpace.scale.setScalar(100);
    handSpace.add(root);
    applyPose(GRIP);
    return { handSpace, root, skinned, bones, rest, applyPose, GRIP, JOINTS };
  }

  // Une baguette effilée, pointe vers +Y, longueur L (unités du parent).
  function chopstickGeometry(THREE, L, rBack, rTip) {
    const g = new THREE.CylinderGeometry(rTip, rBack, L, 14, 8);
    g.translate(0, L / 2, 0); // base à l'origine, pointe en +Y
    return g;
  }

  // Main + baguettes + point de pincement. rig.setOpen(a) écarte la baguette
  // du haut (radians) et déplie légèrement l'index.
  function buildHandRig(THREE, hand, stickTex) {
    const rig = new THREE.Group();
    rig.name = 'handRig';
    rig.scale.setScalar(HAND_SCALE);
    rig.add(hand.handSpace);
    const stickMat = new THREE.MeshStandardMaterial({ map: stickTex, roughness: 0.48 });
    const geo = chopstickGeometry(THREE, 23, 0.33, 0.11);
    const up = new THREE.Vector3(0, 1, 0);
    const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    const U = { p: v3(STICKS.U.p), d: v3(STICKS.U.d).normalize() };
    const L = { p: v3(STICKS.L.p), d: v3(STICKS.L.d).normalize() };
    const n = v3(HOLD.n).normalize();
    const meshU = new THREE.Mesh(geo, stickMat);
    const meshL = new THREE.Mesh(geo, stickMat);
    meshU.castShadow = meshL.castShadow = true;
    meshL.quaternion.setFromUnitVectors(up, L.d);
    meshL.position.copy(L.p).addScaledVector(L.d, -STICKS.L.back);
    rig.add(meshU, meshL);
    const pivot = U.p.clone().addScaledVector(U.d, STICKS.U.pivot);
    // sens d'ouverture : éloigner la pointe du haut de celle du bas
    const tipU = U.p.clone().addScaledVector(U.d, 14);
    const tipL = L.p.clone().addScaledVector(L.d, 14);
    const away = tipU.clone().sub(tipL);
    const sign = new THREE.Vector3().crossVectors(n, U.d).dot(away) > 0 ? 1 : -1;
    const pinch = new THREE.Object3D();
    pinch.position.copy(v3(HOLD.center));
    pinch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    rig.add(pinch);
    const pose = JSON.parse(JSON.stringify(GRIP));
    const d = new THREE.Vector3();
    function setOpen(a) {
      d.copy(U.d).applyAxisAngle(n, sign * a);
      meshU.quaternion.setFromUnitVectors(up, d);
      meshU.position.copy(pivot).addScaledVector(d, -(STICKS.U.pivot + STICKS.U.back));
      const k = a * 57.3; // degrés
      pose.index[1][0] = GRIP.index[1][0] - k * 0.9;
      pose.index[2][0] = GRIP.index[2][0] - k * 1.6;
      pose.index[3][0] = GRIP.index[3][0] - k * 1.0;
      pose.thumb[1][0] = GRIP.thumb[1][0] - k * 0.4;
      pose.middle[2][0] = GRIP.middle[2][0] - k * 0.6;
      hand.applyPose(pose);
    }
    setOpen(0);
    return { rig, pinch, setOpen, meshU, meshL, hand };
  }

  // Lame de yanagiba : dos plus sombre, zone « kasumi » mate, fil poli.
  function bladeTextures(THREE) {
    const W = 256;
    const H = 128;
    const cv = makeCanvas(W, H);
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#8c9296');
    g.addColorStop(0.12, '#a9aeb1');
    g.addColorStop(0.62, '#c3c7ca');
    g.addColorStop(0.7, '#e6e9eb');
    g.addColorStop(1, '#f2f4f5');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const rc = makeCanvas(W, H);
    const rctx = rc.getContext('2d');
    const rg = rctx.createLinearGradient(0, 0, 0, H);
    rg.addColorStop(0, 'rgb(90,90,90)');
    rg.addColorStop(0.62, 'rgb(150,150,150)');
    rg.addColorStop(0.7, 'rgb(40,40,40)');
    rg.addColorStop(1, 'rgb(30,30,30)');
    rctx.fillStyle = rg;
    rctx.fillRect(0, 0, W, H);
    const map = canvasTexture(THREE, cv);
    const rough = canvasTexture(THREE, rc, { srgb: false });
    for (const t of [map, rough]) {
      t.repeat.set(1 / 24.3, 1 / 3.2);
      t.offset.set(0, 0.5);
    }
    return { map, rough };
  }

  /* ------------------------------------------------- plateau des menus */

  // Petites pièces du plateau : faces coupées dessinées, côtés en volume, le
  // tout « encré » comme le grand maki.
  function buildSushiKit(THREE, RoundedBoxGeometry) {
    const noriSmall = noriTextures(THREE, { W: 1024, H: 192, seed: 21, strokes: 600 });
    const face = (kind, seed) =>
      inkify(
        new THREE.MeshStandardMaterial({ map: faceTexture(THREE, kind, seed), roughness: 0.55, side: THREE.DoubleSide }),
        { width: 0.25, strength: 0.6, wobble: 0.004 }
      );
    const fish = (kind, seed) =>
      inkify(
        new THREE.MeshPhysicalMaterial({
          map: fishTexture(THREE, kind, seed),
          roughness: 0.3,
          clearcoat: 0.5,
          clearcoatRoughness: 0.3,
        }),
        { width: 0.34, strength: 0.75, wobble: 0.006 }
      );
    const mats = {
      nori: inkify(
        new THREE.MeshPhysicalMaterial({
          map: noriSmall.map,
          normalMap: noriSmall.normal,
          normalScale: new THREE.Vector2(0.8, 0.8),
          roughness: 0.42,
          sheen: 0.5,
          sheenRoughness: 0.4,
          sheenColor: new THREE.Color('#7f8b86'),
        }),
        { width: 0.3, strength: 0.7, wobble: 0.005 }
      ),
      riceSide: inkify(
        new THREE.MeshStandardMaterial({ map: riceTexture(THREE, { W: 1024, H: 256, sesame: true, seed: 12 }), roughness: 0.62 }),
        { width: 0.3, strength: 0.6, wobble: 0.005 }
      ),
      riceBlock: inkify(new THREE.MeshStandardMaterial({ map: riceTexture(THREE, { seed: 13 }), roughness: 0.62 }), {
        width: 0.36,
        strength: 0.65,
        wobble: 0.01,
      }),
      faces: {
        'hoso-saumon': face('hoso-saumon', 3),
        'hoso-thon': face('hoso-thon', 4),
        'hoso-concombre': face('hoso-concombre', 5),
        ura: face('ura', 6),
        futo: face('futo', 7),
      },
      fish: { saumon: fish('saumon', 8), thon: fish('thon', 9), dorade: fish('dorade', 10) },
      wasabi: inkify(new THREE.MeshStandardMaterial({ color: '#9fb447', roughness: 0.75 }), {
        width: 0.4,
        strength: 0.7,
        wobble: 0.02,
      }),
      gari: inkify(
        new THREE.MeshPhysicalMaterial({ color: '#f3b8a8', roughness: 0.38, clearcoat: 0.4, side: THREE.DoubleSide }),
        { width: 0.3, strength: 0.6, wobble: 0.008 }
      ),
      wood: inkify(new THREE.MeshStandardMaterial({ map: woodTexture(THREE), roughness: 0.62 }), {
        width: 0.22,
        strength: 0.55,
        wobble: 0.01,
      }),
      hull: inkHullMaterial(THREE, { width: 1.5, vary: 1.0, scale: 1.2 }),
      boardHull: inkHullMaterial(THREE, { width: 2.2, vary: 1.1, scale: 0.35 }),
    };
    const outlined = (mesh, geo, mat = mats.hull) => {
      mesh.add(new THREE.Mesh(geo || mesh.geometry, mat));
      return mesh;
    };

    // Rouleaux : un même contour irrégulier pour le côté, les deux faces et
    // la coque du trait d'encre.
    function rollGeo(R, H, seed) {
      const nz = makeNoise(seed);
      const rf = (a) => {
        const u = (((a / (Math.PI * 2)) % 1) + 1) % 1;
        return R * (1 + 0.06 * (nz(u * 5, 0.37, 5) - 0.5) + 0.018 * Math.sin(2 * a + seed));
      };
      const ring = [];
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        ring.push([Math.cos(a) * rf(a), Math.sin(a) * rf(a)]);
      }
      const side = new THREE.CylinderGeometry(1, 1, H, 56, 3, true);
      side.rotateX(Math.PI / 2);
      const p = side.attributes.position;
      const n = side.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        let z = p.getZ(i);
        const a = Math.atan2(y, x);
        const u = (a / (Math.PI * 2) + 1) % 1;
        if (Math.abs(z) > H / 2 - 1e-4) z += (nz(u * 9, z > 0 ? 2.1 : 5.3, 9) - 0.5) * 0.1;
        const r = rf(a);
        const l = Math.hypot(x, y);
        p.setXYZ(i, (x / l) * r, (y / l) * r, z);
        n.setXYZ(i, x / l, y / l, 0);
      }
      return { side, cap: irregularDisc(THREE, rf, 56), hull: hullPrism(THREE, ring, 0, 0, H, 0.08, 2), H };
    }

    // Pavé aux arêtes arrondies avec des sommets sur toute la surface (on peut
    // donc le courber) et des normales lisses, sans couture aux arêtes.
    function softBox(w, h, d, r, sx, sy, sz) {
      const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
      const p = g.attributes.position;
      const n = g.attributes.normal;
      const ix = w / 2 - r;
      const iy = h / 2 - r;
      const iz = d / 2 - r;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const cx = clamp(x, -ix, ix);
        const cy = clamp(y, -iy, iy);
        const cz = clamp(z, -iz, iz);
        let dx = x - cx;
        let dy = y - cy;
        let dz = z - cz;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l;
        dy /= l;
        dz /= l;
        p.setXYZ(i, cx + dx * r, cy + dy * r, cz + dz * r);
        n.setXYZ(i, dx, dy, dz);
      }
      return g;
    }

    // Petites bosses pour casser la perfection des volumes (les normales
    // d'origine suffisent pour des écarts si faibles).
    function jitter(geo, amp, seed) {
      const nz = makeNoise(seed);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        p.setXYZ(
          i,
          x + (nz(y * 1.3 + 3, z * 1.3) - 0.5) * amp,
          y + (nz(z * 1.3 + 7, x * 1.3) - 0.5) * amp,
          z + (nz(x * 1.3 + 11, y * 1.3) - 0.5) * amp
        );
      }
      return geo;
    }

    // Tranche de poisson posée sur le riz : bombée au centre, bouts qui tombent.
    const slice = softBox(4.7, 2.25, 0.34, 0.14, 24, 10, 2);
    {
      const p = slice.attributes.position;
      const n = slice.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const s = 1.3 * y + x;
        p.setZ(i, p.getZ(i) - 0.085 * x * x + 0.04 * Math.sin(s));
        // normale de la surface déformée : (nx − hx·nz, ny − hy·nz, nz)
        const hx = -0.17 * x + 0.04 * Math.cos(s);
        const hy = 0.052 * Math.cos(s);
        const nz = n.getZ(i);
        const v = [n.getX(i) - hx * nz, n.getY(i) - hy * nz, nz];
        const l = Math.hypot(v[0], v[1], v[2]);
        n.setXYZ(i, v[0] / l, v[1] / l, v[2] / l);
      }
    }

    // Wasabi : petite boule irrégulière, aplatie.
    const wasabiGeo = new THREE.SphereGeometry(0.85, 28, 18);
    {
      const nz = makeNoise(44);
      const p = wasabiGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const k = 1 + (fbm(nz, x * 1.6 + 5, y * 1.6 + z, 3) - 0.5) * 0.55;
        p.setXYZ(i, x * k, y * k, Math.max(-0.32, z * k * 0.72));
      }
      wasabiGeo.rotateX(Math.PI / 2);
      wasabiGeo.computeVertexNormals();
    }

    const geos = {
      hoso: rollGeo(1.3, 1.55, 31),
      ura: rollGeo(1.45, 1.65, 32),
      futo: rollGeo(1.95, 1.85, 33),
      rice: jitter(softBox(4.1, 1.95, 1.4, 0.55, 12, 6, 4), 0.09, 51),
      slice,
      sashimi: jitter(softBox(0.62, 3.4, 2.1, 0.22, 2, 10, 6), 0.05, 52),
      wasabi: wasabiGeo,
      // pétale de gingembre : coupelle peu profonde, sommet à l'origine
      petal: (() => {
        const g = new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, 0.62);
        g.translate(0, -1, 0);
        g.rotateX(Math.PI / 2);
        return g;
      })(),
      board: new RoundedBoxGeometry(PLATE.W, PLATE.D, PLATE.TOP, 3, 0.35),
      foot: new RoundedBoxGeometry(2.2, PLATE.D - 2, 1.4, 2, 0.3),
    };

    const shade = (o) => {
      o.traverse((m) => {
        if (m.isMesh && !m.material.isShaderMaterial) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      return o;
    };
    const rnd = mulberry32(808);

    return {
      roll(kind) {
        const type = kind.startsWith('hoso') ? 'hoso' : kind;
        const g = geos[type];
        const group = new THREE.Group();
        group.add(new THREE.Mesh(g.side, type === 'ura' ? mats.riceSide : mats.nori));
        group.add(new THREE.Mesh(g.hull, mats.hull));
        for (const z of [g.H / 2 - 0.004, -g.H / 2 + 0.004]) {
          const capMesh = new THREE.Mesh(g.cap, mats.faces[kind]);
          capMesh.position.z = z;
          group.add(capMesh);
        }
        group.userData.h = g.H;
        return shade(group);
      },
      nigiri(kind) {
        const group = new THREE.Group();
        const rice = outlined(new THREE.Mesh(geos.rice, mats.riceBlock));
        rice.position.z = 0.7;
        const top = outlined(new THREE.Mesh(geos.slice, mats.fish[kind]));
        top.position.z = 1.52;
        group.add(rice, top);
        return shade(group);
      },
      sashimi(kind) {
        return shade(outlined(new THREE.Mesh(geos.sashimi, mats.fish[kind])));
      },
      wasabi() {
        const group = new THREE.Group();
        const m = outlined(new THREE.Mesh(geos.wasabi, mats.wasabi));
        m.position.z = 0.32;
        group.add(m);
        return shade(group);
      },
      gari() {
        // gingembre mariné : fines tranches roses en rosace, penchées vers
        // l'extérieur, un second rang plus serré au centre
        const group = new THREE.Group();
        const ring = (n, r, tilt, z, s) => {
          for (let k = 0; k < n; k++) {
            const petal = new THREE.Mesh(geos.petal, mats.gari);
            const a = (k / n) * Math.PI * 2 + rnd() * 0.5;
            petal.scale.set(1.9 * s, 1.3 * s, 1.4);
            petal.rotation.set(tilt + rnd() * 0.25, 0, a + Math.PI / 2, 'ZXY');
            petal.position.set(Math.cos(a) * r, Math.sin(a) * r, z + rnd() * 0.1);
            group.add(petal);
          }
        };
        ring(6, 0.8, 0.95, 0.45, 1);
        ring(3, 0.28, 0.45, 0.75, 0.8);
        return shade(group);
      },
      plate() {
        // geta : planche en bois clair sur deux pieds
        const group = new THREE.Group();
        const board = outlined(new THREE.Mesh(geos.board, mats.wood), null, mats.boardHull);
        board.position.z = PLATE.TOP / 2;
        group.add(board);
        for (const x of [-1, 1]) {
          const foot = outlined(new THREE.Mesh(geos.foot, mats.wood), null, mats.boardHull);
          foot.position.set(x * (PLATE.W / 2 - 3.6), 0, -0.7);
          group.add(foot);
        }
        return shade(group);
      },
    };
  }

  // Plateau : dimensions, puis inclinaison et rotation de présentation (vu
  // d'en haut, de trois quarts, en diagonale).
  const PLATE = { W: 27, D: 13.5, TOP: 1.3, TILT: -0.74, YAW: 0.2 };

  // Les sushis des trois menus, disposés sur le même plateau ; seuls ceux du
  // menu choisi sont visibles.
  function buildPlate(THREE, kit) {
    const group = new THREE.Group();
    group.add(kit.plate());
    const rnd = mulberry32(606);
    const menus = [[], [], []];
    const T = PLATE.TOP;
    const place = (m, o, x, y, z, rz, tilt = 0.06) => {
      o.position.set(x, y, z);
      o.rotation.set((rnd() - 0.5) * tilt, (rnd() - 0.5) * tilt, rz);
      const s = 0.95 + rnd() * 0.08;
      o.scale.setScalar(s);
      o.userData.base = { x, y, z, s };
      o.visible = false;
      group.add(o);
      menus[m].push(o);
      return o;
    };
    const row = (n, x0, x1, fn) => {
      for (let i = 0; i < n; i++) fn(n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1), i);
    };
    const roll = (m, kind, x, y) => {
      const o = kit.roll(kind);
      place(m, o, x, y, T + o.userData.h / 2, rnd() * Math.PI * 2);
    };
    // nigiri posés en biais, le long de la profondeur du plateau
    const nigiri = (m, kind, x, y) => place(m, kit.nigiri(kind), x, y, T, Math.PI / 2 + 0.35 + (rnd() - 0.5) * 0.1, 0.04);
    const fan = (m, kind, x, y) => {
      for (let k = 0; k < 3; k++) {
        const o = place(m, kit.sashimi(kind), x + k * 0.95, y + (rnd() - 0.5) * 0.2, T + 0.86, 0, 0);
        o.rotation.set(0, 0.95, (rnd() - 0.5) * 0.08);
      }
    };
    const garnish = (m, wx, wy, gx, gy) => {
      place(m, kit.wasabi(), wx, wy, T, rnd() * 6, 0);
      place(m, kit.gari(), gx, gy, T, rnd() * 6, 0);
    };
    const hoso = ['hoso-saumon', 'hoso-thon', 'hoso-concombre'];
    const fishes = ['saumon', 'thon', 'dorade'];

    // Menu 2 : 12 hosomaki (4 × 3), 8 uramaki (4 × 2)
    [2.75, 0, -2.75].forEach((y, r) => row(4, -11.1, -2.85, (x, i) => roll(0, hoso[(i + r) % 3], x, y)));
    [2.2, -0.9].forEach((y) => row(4, 0.2, 9.4, (x) => roll(0, 'ura', x, y)));
    garnish(0, 8.6, -4.4, 4.4, -4.5);
    // Menu 1 : 5 futomaki, 6 nigiri
    row(5, -9.6, 6.8, (x) => roll(1, 'futo', x, 3.2));
    row(6, -9.6, 6.4, (x, i) => nigiri(1, fishes[i % 3], x, -2.7));
    garnish(1, 10.6, -2.8, 10.8, 3.4);
    // Menu Fuji : 6 sashimi, 5 nigiri, 6 hosomaki, 4 uramaki
    fan(2, 'saumon', -11.8, 2.9);
    fan(2, 'thon', -11.8, -2.9);
    row(5, -5.8, 6.8, (x, i) => nigiri(2, fishes[i % 3], x, 3.0));
    [-1.9, -4.65].forEach((y, r) => row(3, -5.7, -0.2, (x, i) => roll(2, hoso[(i + r * 2) % 3], x, y)));
    [-1.8, -4.85].forEach((y) => row(2, 2.8, 5.85, (x) => roll(2, 'ura', x, y)));
    garnish(2, 9.6, -3.6, 10.7, 2.7);

    return { group, menus, current: -1, bump: -10 };
  }

  const backOut = (t) => {
    const c1 = 1.70158;
    return 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };
  const backIn = (t) => {
    const c1 = 1.70158;
    return (c1 + 1) * t * t * t - c1 * t * t;
  };

  // Change de menu : les pièces de l'ancien sautent et disparaissent, celles
  // du nouveau tombent sur le plateau l'une après l'autre.
  function showMenu(plate, i, now) {
    if (plate.current === i) return;
    const old = plate.current;
    if (old >= 0) {
      plate.menus[old].forEach((o, k) => {
        o.userData.anim = { dir: -1, start: now + k * 0.016 };
      });
    }
    const delay = old >= 0 ? 0.3 : 0.05;
    plate.menus[i].forEach((o, k) => {
      o.visible = true;
      o.scale.setScalar(0.0001);
      o.userData.anim = { dir: 1, start: now + delay + k * 0.035 };
    });
    plate.current = i;
    plate.bump = now + delay;
  }

  function animatePlate(plate, now) {
    for (const list of plate.menus) {
      for (const o of list) {
        const a = o.userData.anim;
        if (!a || now < a.start) continue;
        const b = o.userData.base;
        const t = clamp((now - a.start) / 0.55, 0, 1);
        if (a.dir > 0) {
          o.scale.setScalar(b.s * Math.max(0.0001, backOut(t)));
          o.position.set(b.x, b.y, b.z + Math.pow(1 - t, 3) * 4.5);
        } else {
          o.scale.setScalar(b.s * Math.max(0.0001, 1 - backIn(t)));
          o.position.set(b.x, b.y, b.z + t * t * t * 2.5);
        }
        if (t >= 1) {
          if (a.dir < 0) o.visible = false;
          o.position.set(b.x, b.y, b.z);
          o.userData.anim = null;
        }
      }
    }
  }

  /* ------------------------------------------------- chorégraphie du site */

  const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const prog = (a, b, x) => clamp((x - a) / (b - a), 0, 1);
  const smoothstep = (a, b, x) => {
    const t = prog(a, b, x);
    return t * t * (3 - 2 * t);
  };
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  function sampleKeys(keys, t, ease = easeIO) {
    if (t <= keys[0].t) return keys[0];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (t <= b.t) {
        const u = ease((t - a.t) / (b.t - a.t));
        const o = {};
        for (const k in b) o[k] = lerp(a[k], b[k], u);
        return o;
      }
    }
    return keys[keys.length - 1];
  }

  const PI = Math.PI;
  // Section « N'est pas qu'un maki » : positions à l'écran (sx, sy ∈ [-1, 1]),
  // taille (part du plus petit côté de l'écran) et rotations, comme le dessous-
  // de-verre d'Oryzo : un seul retournement, d'un geste, avant de partir vers
  // les baguettes. Les deux faces du maki étant identiques, un demi-tour se lit
  // comme un tour complet (un 360 montrerait deux fois la face : « deux tours »).
  const KEYS_B = [
    { t: 0.0, sx: 0, sy: 0, f: 0.45, rx: -0.4, ry: 0.32, rz: 0 },
    // fin du geste presque dans l'orientation où les baguettes le saisissent
    { t: 1.0, sx: -0.02, sy: 0.04, f: 0.42, rx: -3.06, ry: -0.2, rz: 0.12 },
  ];
  // Position du maki quand la main le saisit, et direction d'où arrive la main
  // (angle à l'écran, en radians) — en paysage puis en portrait.
  const HELD = {
    wide: { sx: -0.15, sy: 0.2, f: 0.24, wrist: -0.6 },
    tall: { sx: 0.04, sy: 0.22, f: 0.3, wrist: -1.12 },
  };

  async function init(opts) {
    const { canvas, onProgress = () => {}, stage = null, onHandHover = () => {} } = opts;
    const { THREE, GLTFLoader, RoomEnvironment, RoundedBoxGeometry } = await loadThree();
    INK.color.value = new THREE.Color('#2a160c');
    INK.res.value = new THREE.Vector2(window.innerWidth, window.innerHeight);
    onProgress(0.2);
    await nextFrame();

    const coarse = matchMedia('(pointer: coarse)').matches;
    const small = Math.min(window.innerWidth, window.innerHeight) < 640;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.6 : 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.5, 600);
    const TAN = Math.tan(THREE.MathUtils.degToRad(14));

    // Lumières : clé chaude en haut à droite, contre-jour, rebond chaud en bas à gauche.
    const key = new THREE.DirectionalLight('#ffecd6', 2.4);
    key.position.set(12, 16, 30);
    key.castShadow = true;
    key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    Object.assign(key.shadow.camera, { left: -26, right: 26, top: 20, bottom: -20, near: 1, far: 100 });
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.025;
    const hemi = new THREE.HemisphereLight('#fff1e0', '#2e1d12', 0.55);
    const rim = new THREE.DirectionalLight('#ffcfa1', 0);
    rim.position.set(-20, 16, 4);
    const warm = new THREE.DirectionalLight('#ffb37e', 0);
    warm.position.set(-14, -18, 10);
    scene.add(key, key.target, hemi, rim, warm);

    // Objets
    const makiAssets = buildMakiAssets(THREE);
    onProgress(0.38);
    await nextFrame();
    const maki = buildMaki(THREE, makiAssets);
    scene.add(maki);
    const set = buildSet(THREE, RoundedBoxGeometry);
    scene.add(set);
    onProgress(0.56);
    await nextFrame();
    const REST_Z = set.userData.boardTop + MAKI.H / 2;
    const TOP_Z = REST_Z + MAKI.H / 2;

    let R = null; // main + baguettes
    try {
      const hand = await loadHand(THREE, GLTFLoader, {});
      R = buildHandRig(THREE, hand, chopstickTexture(THREE));
      R.rig.visible = false;
      scene.add(R.rig);
    } catch (e) {
      console.warn('Main 3D indisponible :', e);
    }
    onProgress(0.8);
    await nextFrame();

    // Plateau de la section « Menus » : les sushis du menu choisi.
    const plate = buildPlate(THREE, buildSushiKit(THREE, RoundedBoxGeometry));
    plate.group.visible = false;
    scene.add(plate.group);
    let menuIndex = 0;
    // Encombrement du plateau une fois incliné, pour le cadrer dans .menus__stage.
    const plateBox = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    {
      const e = new THREE.Euler(PLATE.TILT, 0, PLATE.YAW, 'XYZ');
      const v = new THREE.Vector3();
      for (const x of [-PLATE.W / 2, PLATE.W / 2]) {
        for (const y of [-PLATE.D / 2, PLATE.D / 2]) {
          for (const z of [-1.4, 3.4]) {
            v.set(x, y, z).applyEuler(e);
            plateBox.x0 = Math.min(plateBox.x0, v.x);
            plateBox.x1 = Math.max(plateBox.x1, v.x);
            plateBox.y0 = Math.min(plateBox.y0, v.y);
            plateBox.y1 = Math.max(plateBox.y1, v.y);
          }
        }
      }
    }
    onProgress(0.9);
    await nextFrame();

    // Grains de riz en suspension pour le pied de page : plus sombres que ceux
    // du maki pour rester derrière le texte sans le gêner.
    const FIELD_N = small ? 60 : 110;
    const fieldMat = new THREE.MeshPhysicalMaterial({
      color: '#8f8574',
      roughness: 0.45,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
    });
    const field = new THREE.InstancedMesh(makiAssets.geos.grain, fieldMat, FIELD_N);
    field.frustumCulled = false;
    field.visible = false;
    const fieldData = [];
    {
      const rnd = mulberry32(77);
      for (let i = 0; i < FIELD_N; i++) {
        fieldData.push({
          x: rnd() * 2 - 1,
          y: rnd() * 2 - 1,
          z: rnd() * 2 - 1,
          s: 0.9 + rnd() * 0.8,
          ax: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
          sp: 0.15 + rnd() * 0.5,
          ph: rnd() * 10,
          ox: 0,
          oy: 0,
        });
      }
    }
    scene.add(field);

    /* ---------- mise en page / cadrage */

    const L = {};
    const camBase = new THREE.Vector3();
    const absTop = (el) => el.getBoundingClientRect().top + window.scrollY;
    const q$ = (s) => document.querySelector(s);
    const footerEl = q$('#footer');

    function layout() {
      const vh = window.innerHeight;
      L.vh = vh;
      const hero = q$('#intro');
      const mk = q$('#maki');
      const hd = q$('#bon-appetit');
      L.heroEnd = hero ? hero.offsetHeight : vh;
      L.makiEnd = mk ? absTop(mk) + mk.offsetHeight - vh : vh * 3.4;
      L.handTop = hd ? absTop(hd) : L.makiEnd + vh;
      L.handEnd = hd ? L.handTop + hd.offsetHeight - vh : L.handTop + vh * 2.8;
    }

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      INK.res.value.set(w, h);
      camera.aspect = w / h;
      set.userData.layout(camera.aspect < 0.85);
      camera.updateProjectionMatrix();
      const wReq = clamp(lerp(13.5, 26, (camera.aspect - 0.55) / 1.05), 13.5, 26);
      const d = Math.max(15 / (2 * TAN), wReq / (2 * TAN * camera.aspect));
      camBase.set(0, 0, TOP_Z + d);
      layout();
    }
    resize();

    // Place un objet de diamètre « maki » à l'écran (sx, sy) avec une taille
    // relative au plus petit côté.
    function placeScreen(sx, sy, frac, out) {
      const k = Math.min(1, camera.aspect);
      const dist = (MAKI.R * 2) / (frac * 2 * TAN * k);
      const visH = 2 * TAN * dist;
      return out.set((sx * visH * camera.aspect) / 2, (sy * visH) / 2, camBase.z - dist);
    }
    function worldPerPx(z) {
      return (2 * TAN * (camBase.z - z)) / window.innerHeight;
    }

    /* ---------- préparation de la prise en main */

    // Orientation de la main pour que le poignet parte dans la direction
    // voulue à l'écran, et rotation du maki pour garder l'avocat en haut.
    const Z = new THREE.Vector3(0, 0, 1);
    const holds = {};
    if (R) {
      const qPinchInv = R.pinch.quaternion.clone().invert();
      const holdLocal = R.pinch.position.clone();
      const wristLocal = R.hand.root.getObjectByName('wrist').position.clone().multiplyScalar(100);
      const palmLocal = R.hand.bones['middle-finger-phalanx-proximal'].position.clone().multiplyScalar(100);
      const v = wristLocal.clone().sub(holdLocal).applyQuaternion(qPinchInv);
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.22, 0.34, 0));
      const vt = v.clone().applyQuaternion(tilt);
      for (const k of ['wide', 'tall']) {
        const angle = HELD[k].wrist;
        const roll = angle - Math.atan2(vt.y, vt.x);
        const qTarget = new THREE.Quaternion().setFromAxisAngle(Z, roll).multiply(tilt);
        const yW = new THREE.Vector3(0, 1, 0).applyQuaternion(qTarget);
        // maki saisi « retourné » (ses deux faces sont identiques) : il arrive
        // ainsi dans les baguettes sans refaire de demi-tour après son retournement
        const qMakiLocal = new THREE.Quaternion()
          .setFromAxisAngle(Z, PI / 2 - Math.atan2(yW.y, yW.x))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), PI));
        holds[k] = {
          qMakiLocal,
          qRig: qTarget.clone().multiply(qPinchInv),
          qHeld: qTarget.clone().multiply(qMakiLocal),
          holdLocal,
          palmLocal,
          wristDir: new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0),
        };
      }
    }

    /* ---------- états */

    const intro = { active: false, playing: false, z0: 0, start: 0, dur: 2 };
    const ptr = { x: 0, y: 0, tx: 0, ty: 0, px: -9999, py: -9999 };
    const tmp = {
      v: new THREE.Vector3(),
      v2: new THREE.Vector3(),
      v3: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      q2: new THREE.Quaternion(),
      q3: new THREE.Quaternion(),
      e: new THREE.Euler(),
      m: new THREE.Matrix4(),
      s: new THREE.Vector3(1, 1, 1),
      n3: new THREE.Matrix3(),
    };
    const posRest = new THREE.Vector3(0, 0, REST_Z);
    const posB = new THREE.Vector3();
    const qB = new THREE.Quaternion();
    const posHold = new THREE.Vector3();
    const posFree = new THREE.Vector3();
    const qFree = new THREE.Quaternion();
    const pinchPos = new THREE.Vector3();
    const pinchQ = new THREE.Quaternion();
    let hoverT = 0;
    let hovered = false;
    let rendered = true;
    let canvasFade = 1;
    let clock = 0; // temps de la dernière image (horloge de GSAP)
    const fadeMats = set.userData.fade;
    let lastSetOpacity = 1;

    function keyToPose(k, pos, q) {
      placeScreen(k.sx, k.sy, camera.aspect < 0.85 ? k.f * 0.76 : k.f, pos);
      tmp.e.set(k.rx, k.ry, k.rz, 'XYZ');
      q.setFromEuler(tmp.e);
    }

    function setFade(o) {
      if (Math.abs(o - lastSetOpacity) < 0.002) return;
      lastSetOpacity = o;
      for (const m of fadeMats) m.opacity = o;
    }

    /* ---------- image par image */

    function frame(s, time) {
      clock = time;
      const vh = L.vh;
      ptr.x = lerp(ptr.x, ptr.tx, 0.06);
      ptr.y = lerp(ptr.y, ptr.ty, 0.06);

      // Progressions des phases
      const pA = prog(0, L.heroEnd, s); // intro → void
      const pB = prog(L.heroEnd, L.makiEnd, s); // retournements
      const pT = prog(L.makiEnd, L.handTop, s); // transition vers la main
      const pC = prog(L.handTop, L.handEnd, s); // la main saisit le maki
      const pD = Math.max(0, s - L.handEnd); // sortie (px)
      const exitPx = pD * (1 + (1.4 * pD) / vh); // la main s'en va de plus en plus vite
      const voidT = smoothstep(0.08, 0.85, pA);

      // Caméra (intro + parallaxe du pointeur)
      let camZ = camBase.z;
      if (intro.active) {
        if (intro.playing) {
          const t = clamp((performance.now() - intro.start) / (intro.dur * 1000), 0, 1);
          camZ = lerp(intro.z0, camBase.z, easeIO(t));
          if (t >= 1) intro.active = false;
        } else camZ = intro.z0;
      }
      const par = intro.active ? 0 : 1;
      camera.position.set(ptr.x * 0.7 * par, ptr.y * 0.45 * par, camZ);
      camera.lookAt(ptr.x * 0.2 * par, ptr.y * 0.12 * par, 0);

      // Lumières
      key.intensity = lerp(2.4, 3.0, voidT);
      hemi.intensity = lerp(0.55, 0.2, voidT);
      rim.intensity = lerp(0, 2.6, voidT);
      warm.intensity = lerp(0, 0.4, voidT);
      scene.environmentIntensity = lerp(0.45, 0.3, voidT);
      renderer.toneMappingExposure = lerp(0.95, 1.05, voidT);

      // Décor
      const setT = smoothstep(0.04, 0.72, pA);
      set.visible = setT < 0.999;
      setFade(1 - setT);
      set.position.z = -setT * 8;

      // Maki : intro → retournements
      const mobile = camera.aspect < 0.85;
      // rotation régulière sur toute la section (plus douce que easeIO)
      keyToPose(sampleKeys(KEYS_B, pB, (t) => 0.5 - 0.5 * Math.cos(PI * t)), posB, qB);
      if (pA < 1) {
        const k0 = KEYS_B[0];
        keyToPose(k0, tmp.v, tmp.q);
        const e = easeIO(pA);
        posFree.lerpVectors(posRest, tmp.v, e);
        qFree.identity().slerp(tmp.q, e);
      } else {
        posFree.copy(posB);
        qFree.copy(qB);
      }

      // Maki : vers la main
      const H = mobile ? HELD.tall : HELD.wide;
      const hold = holds[mobile ? 'tall' : 'wide'];
      placeScreen(H.sx, H.sy, H.f, posHold);
      if (R && s > L.makiEnd) {
        const e = easeIO(pT);
        posFree.lerp(posHold, e);
        const turn = easeIO(clamp(pT * 0.7 + pC * 1.6, 0, 1));
        qFree.slerp(hold.qHeld, turn);
        // léger flottement en attendant les baguettes
        const wait = (1 - smoothstep(0.38, 0.44, pC)) * smoothstep(0.6, 1, pT + pC * 3);
        posFree.y += Math.sin(time * 1.6) * 0.12 * wait;
      }

      // Main + baguettes
      let attach = 0;
      if (R) {
        const handVisible = s > L.handTop - vh * 0.3 && s < L.handEnd + vh * 1.4 && pC > 0.02;
        R.rig.visible = handVisible;
        if (handVisible) {
          const enter = easeOut(prog(0.04, 0.4, pC));
          attach = smoothstep(0.39, 0.45, pC);
          const open = lerp(0.1, 0.17, prog(0.04, 0.25, pC)) * (1 - smoothstep(0.31, 0.43, pC));
          // survol
          let hoverTarget = 0;
          if (attach > 0.99 && pC < 0.93 && ptr.px > -999) {
            tmp.v.copy(hold.palmLocal).multiplyScalar(HAND_SCALE).applyQuaternion(R.rig.quaternion).add(R.rig.position).project(camera);
            const hx = (tmp.v.x * 0.5 + 0.5) * window.innerWidth;
            const hy = (-tmp.v.y * 0.5 + 0.5) * window.innerHeight;
            tmp.v.copy(pinchPos).project(camera);
            const mx = (tmp.v.x * 0.5 + 0.5) * window.innerWidth;
            const my = (-tmp.v.y * 0.5 + 0.5) * window.innerHeight;
            // distance du pointeur au segment maki → paume (baguettes et doigts)
            const sx = hx - mx;
            const sy = hy - my;
            const u = clamp(((ptr.px - mx) * sx + (ptr.py - my) * sy) / (sx * sx + sy * sy || 1), 0, 1);
            const dist = Math.hypot(ptr.px - (mx + sx * u), ptr.py - (my + sy * u));
            const rad = Math.min(window.innerWidth, window.innerHeight) * lerp(0.1, 0.2, u);
            hoverTarget = dist < rad ? 1 : 0;
          }
          hoverT = lerp(hoverT, hoverTarget, 0.08);
          const isHover = hoverTarget > 0.5;
          if (isHover !== hovered) {
            hovered = isHover;
            onHandHover(hovered);
          }
          R.setOpen(open + Math.sin(time * 9) * 0.012 * hoverT);

          // orientation : entrée + balancement + survol, autour du point de pincement
          tmp.e.set(
            Math.sin(time * 0.8) * 0.03 * attach - ptr.y * 0.14 * hoverT,
            Math.cos(time * 0.6) * 0.04 * attach + ptr.x * 0.2 * hoverT,
            (1 - enter) * 0.35 + Math.sin(time * 0.5) * 0.02 * attach
          );
          tmp.q.setFromEuler(tmp.e);
          pinchQ.copy(tmp.q).multiply(hold.qRig).multiply(R.pinch.quaternion);
          R.rig.quaternion.copy(tmp.q).multiply(hold.qRig);
          // position : le point de pincement rejoint le maki
          pinchPos.copy(posHold);
          pinchPos.y += exitPx * worldPerPx(posHold.z);
          const off = (1 - enter) * vh * worldPerPx(posHold.z) * 1.15;
          pinchPos.addScaledVector(hold.wristDir, off);
          tmp.v.copy(hold.holdLocal).multiplyScalar(HAND_SCALE).applyQuaternion(R.rig.quaternion);
          R.rig.position.copy(pinchPos).sub(tmp.v);
        } else if (hovered) {
          hovered = false;
          hoverT = 0;
          onHandHover(false);
        }
      }

      // Maki : libre ou tenu par les baguettes
      maki.position.copy(posFree);
      maki.quaternion.copy(qFree);
      if (R && attach > 0) {
        tmp.q2.copy(pinchQ).multiply(hold.qMakiLocal);
        maki.position.lerp(pinchPos, attach);
        maki.quaternion.slerp(tmp.q2, attach);
      } else if (pD > 0) {
        maki.position.y += exitPx * worldPerPx(maki.position.z);
      }
      const introPart = s < L.handEnd + vh * 0.85;
      maki.visible = introPart;
      if (R) R.rig.visible = R.rig.visible && introPart;

      // Plateau des menus, ancré au cadre .menus__stage
      let plateVisible = false;
      if (stage) {
        const r = stage.getBoundingClientRect();
        plateVisible = r.bottom > -vh * 0.2 && r.top < vh * 1.2;
        if (plateVisible) {
          if (plate.current < 0) showMenu(plate, menuIndex, time);
          const W = window.innerWidth;
          const sx = ((r.left + r.width / 2) / W) * 2 - 1;
          const sy = -(((r.top + r.height / 2) / vh) * 2 - 1);
          // distance pour que le plateau incliné remplisse le cadre
          const dW = ((plateBox.x1 - plateBox.x0) * vh) / (2 * TAN * Math.min(r.width, W) * 0.94);
          const dH = ((plateBox.y1 - plateBox.y0) * vh) / (2 * TAN * Math.max(1, r.height) * 0.94);
          const d = Math.max(dW, dH);
          const visH = 2 * TAN * d;
          plate.group.position.set(
            (sx * visH * camera.aspect) / 2 - (plateBox.x0 + plateBox.x1) / 2,
            (sy * visH) / 2 - (plateBox.y0 + plateBox.y1) / 2,
            camBase.z - d
          );
          // petit sursaut quand les pièces arrivent
          const b = time - plate.bump;
          const bump = b > 0 && b < 1.6 ? Math.sin(b * 9) * Math.exp(-b * 3.2) * 0.035 : 0;
          plate.group.scale.set(1 + bump * 0.4, 1 + bump * 0.4, 1 - bump);
          plate.group.rotation.set(
            PLATE.TILT - ptr.y * 0.06,
            0,
            PLATE.YAW + ptr.x * 0.1 + Math.sin(time * 0.4) * 0.035,
            'XYZ'
          );
          animatePlate(plate, time);
        }
      }
      plate.group.visible = plateVisible;

      // La lumière principale suit le plateau pour que ses ombres restent nettes.
      if (plateVisible) key.target.position.copy(plate.group.position);
      else key.target.position.set(0, 0, 0);
      key.position.copy(key.target.position).add(tmp.v.set(12, 16, 30));

      // Grains du pied de page
      let fieldVisible = false;
      if (footerEl) {
        const r = footerEl.getBoundingClientRect();
        fieldVisible = r.top < vh && r.bottom > 0;
        if (fieldVisible) {
          const dist = 34;
          const visH = 2 * TAN * dist;
          const visW = visH * camera.aspect;
          const cy = -(((r.top + r.height / 2) / vh) * 2 - 1) * (visH / 2);
          const pxW = ((ptr.px / window.innerWidth) * 2 - 1) * (visW / 2);
          const pyW = -((ptr.py / vh) * 2 - 1) * (visH / 2);
          fieldData.forEach((g, i) => {
            const x = g.x * visW * 0.62;
            const y = cy + g.y * visH * 0.55 + Math.sin(time * g.sp + g.ph) * 0.6;
            const dx = x - pxW;
            const dy = y - pyW;
            const d = Math.hypot(dx, dy);
            const push = Math.max(0, 1 - d / 6) * 2.2;
            g.ox = lerp(g.ox, d > 0.001 ? (dx / d) * push : 0, 0.08);
            g.oy = lerp(g.oy, d > 0.001 ? (dy / d) * push : 0, 0.08);
            tmp.v.set(x + g.ox, y + g.oy, camBase.z - dist + g.z * 10 - 4);
            tmp.q.setFromAxisAngle(g.ax, time * g.sp + g.ph);
            tmp.s.set(0.25 * g.s, 0.13 * g.s, 0.085 * g.s);
            tmp.m.compose(tmp.v, tmp.q, tmp.s);
            field.setMatrixAt(i, tmp.m);
          });
          field.instanceMatrix.needsUpdate = true;
        }
      }
      field.visible = fieldVisible;

      // La main et le maki s'effacent en quittant l'écran.
      const fade = plateVisible || fieldVisible ? 1 : 1 - smoothstep(vh * 0.3, vh * 0.8, pD);
      if (Math.abs(fade - canvasFade) > 0.003) {
        canvasFade = fade;
        canvas.style.opacity = fade.toFixed(3);
      }

      // Trait « dessiné » : il bouge 8 fois par seconde.
      INK.boil.value = Math.floor(time * 8) % 1000;

      // Rendu seulement quand quelque chose est visible
      const active = intro.active || introPart || plateVisible || fieldVisible;
      if (active) {
        renderer.render(scene, camera);
        rendered = true;
      } else if (rendered) {
        renderer.clear();
        rendered = false;
      }
    }

    // Compile tous les shaders d'avance (y compris objets encore cachés).
    const hidden = [R && R.rig, plate.group, field].filter(Boolean);
    const pieces = plate.menus.flat();
    hidden.forEach((o) => (o.visible = true));
    pieces.forEach((o) => (o.visible = true));
    renderer.compile(scene, camera);
    hidden.forEach((o) => (o.visible = false));
    pieces.forEach((o) => (o.visible = false));
    onProgress(1);

    return {
      frame,
      layout,
      resize,
      setPointer(nx, ny, px, py) {
        ptr.tx = nx;
        ptr.ty = ny;
        ptr.px = px;
        ptr.py = py;
      },
      setMenu(i) {
        menuIndex = clamp(i, 0, 2);
        // le plateau se recompose tout de suite s'il est déjà à l'écran
        if (plate.current >= 0) showMenu(plate, menuIndex, clock);
      },
      intro: {
        prepare(rPx) {
          const d0 = (MAKI.R * (window.innerHeight / 2)) / (rPx * TAN);
          intro.z0 = TOP_Z + d0;
          intro.active = true;
          intro.playing = false;
        },
        play(dur) {
          intro.dur = dur;
          intro.start = performance.now();
          intro.playing = true;
        },
      },
      debug: { THREE, scene, camera, renderer, maki, set, R, plate, field, L, holds },
    };
  }

  /* --------------------------------------------------------------- exports */

  let libsPromise = null;
  function loadThree() {
    if (!libsPromise) {
      libsPromise = Promise.all([
        import('three'),
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/environments/RoomEnvironment.js'),
        import('three/addons/geometries/RoundedBoxGeometry.js'),
      ]).then(([THREE, gltf, env, rbox]) => ({
        THREE,
        GLTFLoader: gltf.GLTFLoader,
        RoomEnvironment: env.RoomEnvironment,
        RoundedBoxGeometry: rbox.RoundedBoxGeometry,
      }));
    }
    return libsPromise;
  }

  window.FujiScene = {
    init,
    loadThree,
    MAKI,
    builders: {
      buildMakiAssets,
      buildMaki,
      buildSet,
      loadHand,
      buildHandRig,
      chopstickGeometry,
      chopstickTexture,
    },
    util: { mulberry32, makeNoise, fbm, clamp, lerp },
  };
})();
