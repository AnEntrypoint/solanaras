import {
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  WebGPURenderer
} from 'three';
import {
  Break, Fn, If, Loop, abs, clamp, cos, dot, exp, float, floor, fract, length, max, mix,
  normalize, screenSize, screenUV, sin, step, time, uniform, vec2, vec3, vec4
} from 'three/tsl';

const EXPOSURE = 0.6;

const hash = (seed) => fract(sin(dot(seed, vec2(1.5977, 9.6226))).mul(43758.5453));

const valueNoise = Fn(([point]) => {
  const p = vec3(point);
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));

  const n = cell.x.add(cell.y.mul(57.0)).add(cell.z.mul(113.0));
  const h0 = fract(sin(vec4(n).add(vec4(0.0, 1.0, 57.0, 58.0))).mul(43758.5453));
  const h1 = fract(sin(vec4(n).add(vec4(113.0, 114.0, 170.0, 171.0))).mul(43758.5453));

  const hz = mix(h0, h1, f.z);
  const hy = mix(hz.xy, hz.zw, f.y);
  return mix(hy.x, hy.y, f.x);
});

const fbm = Fn(([point]) => {
  const p = vec3(point);
  return valueNoise(p.mul(0.06125)).mul(0.57)
    .add(valueNoise(p.mul(0.125)).mul(0.28))
    .add(valueNoise(p.mul(0.25)).mul(0.15));
});

const cosNoise = (p) => float(0.5).mul(sin(p.x).add(sin(p.y)));

const rotate2D = (p, angle) => {
  const c = cos(angle);
  const s = sin(angle);
  return c.mul(p).add(s.mul(vec2(p.y, p.x.negate())));
};

const sdTorus = (p, radii) => {
  const q = vec2(length(p.xz).sub(radii.x.mul(1.2)), p.y);
  return length(q).sub(radii.y);
};

const smin = (a, b, k) => {
  const h = clamp(float(0.5).add(float(0.5).mul(b.sub(a)).div(k)), 0.0, 1.0);
  return mix(b, a, h).sub(k.mul(h).mul(float(1.0).sub(h)));
};

const sunSurface = Fn(([position, animTime]) => {
  const pos = vec3(position);
  const h = float(0.0).toVar();
  const q = pos.xz.mul(0.5).toVar();
  const s = float(0.5).toVar();

  Loop(5, () => {
    h.addAssign(s.mul(cosNoise(q)));
    q.assign(vec2(
      q.x.mul(1.36).add(q.y.mul(1.02)).add(2.41),
      q.x.mul(-1.02).add(q.y.mul(1.36)).add(8.13)
    ));
    s.mulAssign(float(0.48).add(float(0.2).mul(h)));
  });

  h.mulAssign(2.05);
  const d1 = pos.y.sub(h);

  const rawMod = pos.add(3.3).mul(0.1);
  const r1 = rawMod.sub(floor(rawMod)).mul(10.0).sub(5.0).toVar();
  r1.y.assign(pos.y.sub(0.1).sub(h.mul(0.7)).add(float(0.5).mul(sin(animTime.mul(3.0).add(pos.x).add(pos.z.mul(3.0))))));

  const c = cos(pos.x);
  const rxz = c.mul(r1.xz).add(vec2(r1.z, r1.x.negate()));
  r1.x.assign(rxz.x);
  r1.z.assign(rxz.y);

  const ratio = clamp(abs(pos.x.div(pos.z.add(0.0001))), 0.7, 2.5);
  const d2 = sdTorus(vec3(r1.x, r1.z, r1.y), vec2(ratio, 0.20));

  return smin(d1, d2, float(1.0));
});

const sceneSdf = Fn(([point, animTime, mouse, scroll]) => {
  const p = vec3(point).toVar();
  p.z.addAssign(1.0);

  const pitchAngle = float(-25.5).add(mouse.y.mul(0.28)).add(sin(scroll.mul(3.14159)).mul(0.55));
  const ryz = rotate2D(vec2(p.y, p.z), pitchAngle);
  p.y.assign(ryz.x);
  p.z.assign(ryz.y);

  const yawAngle = mouse.x.mul(1.15).add(animTime.mul(0.09)).add(scroll.mul(2.4));
  const rxz = rotate2D(vec2(p.x, p.z), yawAngle);
  p.x.assign(rxz.x);
  p.z.assign(rxz.y);

  const dBase = sunSurface(p, animTime).toVar();
  If(dBase.lessThan(0.65), () => {
    dBase.addAssign(fbm(p.mul(50.0).add(animTime.mul(25.0))).mul(0.45));
  });

  return dBase;
});

const blackbodyColor = (heat) => {
  const temperature = float(1400.0).add(float(1300.0).mul(heat));
  const planckScale = vec3(22190.066, 5507.317, 1649.162);
  const channelWavelength = vec3(7.4, 5.6, 4.4);
  const denom = planckScale.mul(exp(float(143876.72).div(channelWavelength.mul(temperature))).sub(1.0));
  return vec3(1.0).sub(exp(vec3(-5e8).div(denom)));
};

const solarFuryShader = Fn(([mouse, scroll, ultraviolet, timeScale]) => {
  const animTime = time.mul(timeScale);
  const uv = vec2(screenUV.x, float(1.0).sub(screenUV.y));
  const aspect = screenSize.x.div(screenSize.y);
  const centered = vec2(uv.x.sub(0.5).mul(aspect), uv.y.sub(0.5));

  const rd = normalize(vec3(centered.x, centered.y, 1.0));
  const diveDepth = sin(scroll.mul(3.14159)).mul(5.2);
  const ro = vec3(0.0, 0.0, float(-22.0).add(diveDepth));

  const glow = float(0.0).toVar();
  const opacity = float(0.0).toVar();
  const weight = float(0.0).toVar();
  const sdf = float(1.0).toVar();
  const marchT = float(1.0).toVar();

  const glowRadius = float(0.1);
  const heat = float(0.0).toVar();
  const seed = uv.add(fract(animTime));

  Loop(44, ({ i }) => {
    If(
      opacity.greaterThan(0.985)
        .or(sdf.lessThan(marchT.mul(0.0012)))
        .or(marchT.greaterThan(38.0)),
      () => { Break(); }
    );

    sdf.assign(sceneSdf(ro.add(rd.mul(marchT)), animTime, mouse, scroll));
    glow.assign(glowRadius.sub(sdf).mul(step(sdf, glowRadius)));
    weight.assign(float(1.0).sub(opacity).mul(glow));

    heat.addAssign(weight.mul(weight).add(1.0 / 42.0));
    opacity.addAssign(weight.add(1.0 / 165.0));

    const iFloat = float(i).add(1.0);
    const jitter = hash(seed.mul(iFloat)).mul(0.28);
    const baseFactor = mix(float(0.8), float(1.0), ultraviolet);

    sdf.assign(abs(sdf).mul(baseFactor.add(jitter)));
    sdf.assign(max(sdf, 0.048));
    marchT.addAssign(sdf.mul(0.52));
  });

  const finalColor = blackbodyColor(heat).toVar();
  const uvBoost = float(1.0).div(exp(glow.mul(2.82))).mul(1.05);
  finalColor.assign(mix(finalColor, finalColor.mul(uvBoost), ultraviolet));

  return vec4(finalColor.mul(float(EXPOSURE)), 1.0);
});

export function startSolar({ container, badge, uvButton = null, qualityButton = null, onProgress = null }) {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const lifetime = new AbortController();
  const { signal } = lifetime;

  const uMouse = uniform(new Vector2(0, 0));
  const uScroll = uniform(0.0);
  const uUltraviolet = uniform(0.0);
  const uTimeScale = uniform(prefersReducedMotion ? 0.15 : 1.0);

  const material = new MeshBasicNodeMaterial();
  material.colorNode = solarFuryShader(uMouse, uScroll, uUltraviolet, uTimeScale);
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  const scene = new Scene();
  scene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const targetMouse = new Vector2(0, 0);
  let targetScroll = 0;
  let targetUV = 0.0;
  let manualUV = false;
  let adaptiveScaling = true;
  let currentScale = isMobile ? 0.7 : Math.min(window.devicePixelRatio, 1.2);
  let renderer = null;
  let isTabVisible = true;
  let frameCount = 0;
  let lastCheck = performance.now();
  let backendName = 'WebGPU';

  function updateRendererSize() {
    if (!renderer) return;
    renderer.setPixelRatio(currentScale);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  function stopRenderer() {
    if (!renderer) return;
    renderer.setAnimationLoop(null);
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }

  function showFallback() {
    badge.textContent = 'Shader Fallback Active';
    container.style.background = 'radial-gradient(circle at 50% 60%, rgba(255, 90, 0, 0.35), #050100 70%)';
  }

  function adaptScale(fps) {
    const maxScale = isMobile ? 0.95 : 1.25;
    if (fps < 48 && currentScale > 0.5) {
      currentScale = Math.max(0.5, +(currentScale - 0.08).toFixed(2));
      updateRendererSize();
    } else if (fps > 58 && currentScale < maxScale) {
      currentScale = Math.min(maxScale, +(currentScale + 0.04).toFixed(2));
      updateRendererSize();
    }
  }

  function frame(now) {
    if (!isTabVisible) return;

    frameCount++;
    const elapsed = now - lastCheck;
    if (elapsed >= 500) {
      const fps = Math.round((frameCount * 1000) / elapsed);
      if (adaptiveScaling) adaptScale(fps);
      badge.textContent = `${backendName} • ${fps} FPS • ${Math.round(currentScale * 100)}% Res`;
      frameCount = 0;
      lastCheck = now;
    }

    uMouse.value.lerp(targetMouse, 0.05);
    uScroll.value += (targetScroll - uScroll.value) * 0.06;
    uUltraviolet.value += (targetUV - uUltraviolet.value) * 0.05;
    renderer.render(scene, camera);
  }

  async function boot(forceWebGL) {
    stopRenderer();
    const instance = new WebGPURenderer({ antialias: false, powerPreference: 'high-performance', forceWebGL });
    renderer = instance;
    instance.onDeviceLost = () => {
      if (renderer !== instance) return;
      stopRenderer();
      if (forceWebGL) {
        console.warn('Shader device lost on WebGL2; showing fallback');
        showFallback();
        return;
      }
      console.warn('Shader device lost; restarting on WebGL2 at half resolution');
      currentScale = 0.5;
      boot(true);
    };
    updateRendererSize();
    container.appendChild(instance.domElement);

    try {
      await instance.init();
    } catch (err) {
      if (renderer !== instance) return;
      console.error('Helios GPU initialization error:', err);
      stopRenderer();
      showFallback();
      return;
    }
    if (renderer !== instance) return;

    backendName = instance.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    instance.setAnimationLoop(frame);
  }

  function setUltraviolet(level) {
    if (!manualUV) targetUV = level;
  }

  window.addEventListener('pointermove', (e) => {
    targetMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    targetMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }, { passive: true, signal });

  window.addEventListener('scroll', () => {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    targetScroll = Math.min(1.0, Math.max(0.0, window.scrollY / maxScroll));
    onProgress?.(targetScroll);
  }, { passive: true, signal });

  window.addEventListener('resize', updateRendererSize, { passive: true, signal });

  document.addEventListener('visibilitychange', () => {
    isTabVisible = !document.hidden;
  }, { signal });

  uvButton?.addEventListener('click', () => {
    manualUV = !manualUV;
    targetUV = manualUV ? 1.0 : 0.0;
    uvButton.textContent = manualUV ? '🟣 Spectrum: Ultraviolet' : '☀️ Spectrum: Blackbody';
  }, { signal });

  qualityButton?.addEventListener('click', () => {
    adaptiveScaling = !adaptiveScaling;
    if (adaptiveScaling) {
      qualityButton.textContent = '⚡ Auto-Scale';
    } else {
      currentScale = Math.min(window.devicePixelRatio, 1.4);
      qualityButton.textContent = '🔒 Quality: High';
    }
    updateRendererSize();
  }, { signal });

  function dispose() {
    lifetime.abort();
    quad.geometry.dispose();
    material.dispose();
    stopRenderer();
  }

  boot(false);

  return { setUltraviolet, dispose };
}
