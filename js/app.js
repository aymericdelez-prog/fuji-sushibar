/* ==========================================================================
   Fuji Sushibar — interactions
   Préchargement, défilement fluide (Lenis), animations au scroll (GSAP /
   ScrollTrigger), survols, curseur, horaires en direct. La scène 3D est
   pilotée depuis ici : scene.frame(scroll) à chaque image.
   ========================================================================== */
(function () {
  'use strict';

  const html = document.documentElement;
  const body = document.body;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // Sans GSAP (CDN bloqué), on affiche simplement la page.
  if (!window.gsap || !window.ScrollTrigger) {
    $('.loader')?.remove();
    body.classList.remove('is-loading');
    return;
  }

  html.classList.add('js');
  gsap.registerPlugin(ScrollTrigger);

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  /* ------------------------------------------------- défilement fluide */

  let lenis = null;
  if (!reduce && window.Lenis) {
    lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9 });
    lenis.on('scroll', ScrollTrigger.update);
    lenis.stop();
  }
  const getScroll = () => (lenis ? lenis.scroll : window.scrollY);
  function scrollToTarget(target) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return;
    const offset = el.closest('.carte') && el.classList.contains('cat') ? -110 : 0;
    if (lenis) lenis.scrollTo(el, { offset, duration: 1.6 });
    else el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  }
  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id.length < 2 || !$(id)) return;
      e.preventDefault();
      scrollToTarget(id);
    });
  });

  /* ---------------------------------------------- petits outils de texte */

  // Texte qui roule au survol : double le libellé.
  $$('.roll').forEach((el) => {
    const t = el.dataset.text || el.textContent;
    el.textContent = '';
    const inner = document.createElement('span');
    inner.className = 'roll__in';
    const a = document.createElement('span');
    a.textContent = t;
    const b = document.createElement('span');
    b.textContent = t;
    b.setAttribute('aria-hidden', 'true');
    inner.append(a, b);
    el.append(inner);
  });

  function splitWords(el) {
    const words = el.textContent.trim().split(/\s+/);
    el.textContent = '';
    return words.map((w, i) => {
      const s = document.createElement('span');
      s.className = 'dim-word';
      s.textContent = w;
      el.appendChild(s);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
      return s;
    });
  }

  // Allume progressivement une liste d'éléments entre les progressions a et b.
  function setDim(list, p, a, b) {
    const n = list.length;
    const span = (b - a) / Math.max(1, n);
    list.forEach((el, i) => {
      const t0 = a + ((b - a) * i) / Math.max(1, n);
      const m = clamp((p - t0) / (span * 1.6), 0, 1);
      el.style.color = `rgba(255, 237, 215, ${lerp(0.16, 1, m).toFixed(3)})`;
    });
  }

  /* -------------------------------------------------------- scène 3D */

  let scene = null;
  let realProgress = 0;
  const canvas = $('.webgl');
  const sceneReady = (window.FujiScene
    ? FujiScene.init({
        canvas,
        onProgress: (p) => {
          realProgress = Math.max(realProgress, p * 0.96);
        },
        stage: $('.menus__stage'),
        onHandHover: (h) => cursor && cursor.setHand(h),
      })
    : Promise.reject(new Error('scene.js absent'))
  )
    .then((api) => {
      scene = api;
    })
    .catch((err) => {
      console.warn('Scène 3D indisponible :', err);
      html.classList.add('no-webgl');
    });

  Promise.all([sceneReady, document.fonts ? document.fonts.ready : null]).then(() => {
    realProgress = 1;
  });
  setTimeout(() => {
    realProgress = 1;
  }, 15000);

  // Une seule boucle : Lenis, puis la scène.
  gsap.ticker.add((time) => {
    if (lenis) lenis.raf(time * 1000);
    if (scene) scene.frame(getScroll(), time);
  });
  gsap.ticker.lagSmoothing(0);

  /* ---------------------------------------------------- préchargement */

  const loader = $('.loader');
  const pctEl = $('.loader__pct');
  const fill = $('.loader__fill');
  const FILL_LEN = 2 * Math.PI * 131;
  fill.style.strokeDasharray = FILL_LEN;
  fill.style.strokeDashoffset = FILL_LEN;

  gsap.from('.loader__guides line', {
    scale: 0,
    transformOrigin: '50% 50%',
    duration: 1.4,
    ease: 'expo.out',
    stagger: 0.06,
  });
  gsap.from('.loader__drawing > *', { opacity: 0, rotation: -40, transformOrigin: '50% 50%', duration: 1.2, ease: 'expo.out', stagger: 0.08 });
  gsap.from('.loader__handles > *', { opacity: 0, scale: 0.4, transformOrigin: '50% 50%', duration: 0.8, ease: 'back.out(2)', stagger: 0.02, delay: 0.5 });

  let shown = 0;
  const t0 = performance.now();
  let last = t0;
  const minDur = reduce ? 300 : 1800;
  (function tick() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    const timeCap = clamp((now - t0) / minDur, 0, 1);
    const target = Math.min(realProgress, timeCap);
    shown += (target - shown) * (1 - Math.exp(-dt * 7));
    if (target >= 1 && shown > 0.994) shown = 1;
    pctEl.textContent = Math.round(shown * 100);
    fill.style.strokeDashoffset = FILL_LEN * (1 - shown);
    if (shown < 1) requestAnimationFrame(tick);
    else onLoaded();
  })();

  function onLoaded() {
    const outer = $('.loader__outer').getBoundingClientRect();
    if (scene) scene.intro.prepare(outer.width / 2, outer.left + outer.width / 2, outer.top + outer.height / 2);
    const tl = gsap.timeline();
    tl.to('.loader__fill', { opacity: 0, duration: 0.35 })
      .to('.loader__guides, .loader__meta', { opacity: 0, duration: 0.6 }, '<')
      .to(loader, { backgroundColor: 'rgba(16, 9, 4, 0)', duration: 0.7, ease: 'power2.out' }, '<0.1')
      .to('.loader__handles', { opacity: 0, duration: 0.5 }, '<0.35')
      .to('.loader__drawing', { opacity: 0, duration: 0.6 }, '<0.1')
      .add(() => {
        if (scene) scene.intro.play(reduce ? 0.01 : 2.1);
      }, '<')
      .add(heroIn, '<0.8')
      .add(() => {
        loader.remove();
        body.classList.remove('is-loading');
        if (lenis) lenis.start();
        ScrollTrigger.refresh();
      }, '+=0.2');
  }

  function heroIn() {
    gsap.from('.hero__letter', { yPercent: 108, duration: 1.4, ease: 'expo.out', stagger: 0.07 });
    gsap.from('.hero__tagline', { yPercent: 110, duration: 1.1, ease: 'expo.out', delay: 0.35 });
    gsap.from(['.hero__copy', '.hero__card', '.hero__promo', '.hero__scroll'], {
      opacity: 0,
      y: 26,
      duration: 1.2,
      ease: 'expo.out',
      stagger: 0.09,
      delay: 0.45,
    });
    gsap.from(['.nav__link', '.side-tab'], { opacity: 0, y: -14, duration: 1, ease: 'expo.out', stagger: 0.05, delay: 0.3 });
  }

  /* -------------------------------------------------- intro → void */

  // L'entrée anime yPercent / les enfants de .hero__ui ; la sortie au scroll
  // anime y / opacity et le conteneur : les deux ne se marchent pas dessus.
  gsap
    .timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } })
    .to('.hero__letter', { y: () => -window.innerHeight * 0.12, opacity: 0, ease: 'none', stagger: 0.05 }, 0)
    .to('.hero__tagline', { opacity: 0, ease: 'none' }, 0)
    .to('.hero__ui', { opacity: 0, y: () => -window.innerHeight * 0.08, ease: 'none' }, 0)
    .to('.hero__vignette', { opacity: 0, ease: 'none', duration: 0.35 }, 0);

  ScrollTrigger.create({
    trigger: '.hero',
    start: 'top+=35% top',
    end: 'max',
    onToggle: (st) => body.classList.toggle('is-scrolled', st.isActive),
  });

  /* ------------------------------------------- N'est pas qu'un maki */

  const makiLines = $$('#maki .maki__title > span');
  const makiWords = splitWords($('#maki .maki__copy'));
  const makiTexts = ['#maki .maki__title', '#maki .maki__copy', '#maki .footnote'];
  gsap.set(makiTexts, { opacity: 0 });
  ScrollTrigger.create({
    trigger: '#maki',
    start: 'top top',
    end: 'bottom bottom',
    onUpdate: (st) => {
      // La section commence sous l'intro. s = défilement en hauteurs d'écran :
      // de 0 à 1, c'est la fin de l'intro ; pB suit ensuite le tour complet
      // du maki (scene.js).
      const span = (st.end - st.start || 1) / window.innerHeight;
      const s = st.progress * span;
      const pB = clamp((s - 1) / Math.max(0.01, span - 1), 0, 1);
      const inA = clamp((s - 0.55) / 0.45, 0, 1);
      // les textes s'effacent à la fin du tour
      const out = clamp((pB - 0.9) / 0.08, 0, 1);
      const o = inA * (1 - out);
      makiTexts.forEach((sel) => gsap.set(sel, { opacity: o }));
      setDim(makiLines, s, 0.62, 1.0);
      setDim(makiWords, s, 0.78, 1.22);
    },
  });

  /* --------------------------------------------------- Bon appétit */

  const baSide = $$('.ba__side > span');
  gsap.set(['.ba__hint', '.ba__side', '#bon-appetit .footnote'], { opacity: 0 });
  gsap.fromTo(
    '.ba__title-txt',
    { yPercent: 40, opacity: 0, letterSpacing: '0.06em' },
    {
      yPercent: 0,
      opacity: 1,
      letterSpacing: '-0.01em',
      ease: 'none',
      scrollTrigger: { trigger: '#bon-appetit', start: 'top 85%', end: 'top 15%', scrub: true },
    }
  );
  gsap.fromTo(
    ['.ba__title sup', '.ba__jp'],
    { opacity: 0, y: 14 },
    { opacity: 1, y: 0, ease: 'none', scrollTrigger: { trigger: '#bon-appetit', start: 'top 40%', end: 'top top', scrub: true } }
  );
  ScrollTrigger.create({
    trigger: '#bon-appetit',
    start: 'top top',
    end: 'bottom bottom',
    onUpdate: (st) => {
      const p = st.progress;
      const show = clamp((p - 0.42) / 0.08, 0, 1);
      const out = clamp((p - 0.9) / 0.08, 0, 1);
      gsap.set(['.ba__hint', '#bon-appetit .footnote'], { opacity: show * (1 - out) });
      gsap.set('.ba__side', { opacity: 1 - out });
      setDim(baSide, p, 0.46, 0.66);
      gsap.set('.ba__head', { opacity: 1 - out * 0.85 });
    },
  });

  /* ----------------------------------------------------------- bandeau */

  gsap.fromTo(
    '.marquee__track',
    { xPercent: 0 },
    { xPercent: -50, ease: 'none', scrollTrigger: { trigger: '.marquee', start: 'top bottom', end: 'bottom top', scrub: 0.6 } }
  );

  /* ---------------------------------------------------- apparitions */

  function revealOnEnter(targets, vars = {}, trigger) {
    $$(targets).forEach((el) => {
      gsap.fromTo(
        el,
        { opacity: 0, y: vars.y ?? 30 },
        {
          opacity: 1,
          y: 0,
          duration: vars.duration ?? 1.1,
          ease: 'expo.out',
          delay: vars.delay ?? 0,
          scrollTrigger: { trigger: trigger || el, start: vars.start || 'top 88%', once: true },
        }
      );
    });
  }
  revealOnEnter('.reveal');
  $$('.reveal-lines').forEach((el) => {
    el.style.overflow = 'hidden';
    gsap.fromTo(
      el.children,
      { yPercent: 105, opacity: 0 },
      {
        yPercent: 0,
        opacity: 1,
        duration: 1.2,
        ease: 'expo.out',
        stagger: 0.08,
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      }
    );
  });

  /* ------------------------------------------------------------ carte */

  $$('.cat').forEach((cat) => {
    const art = $$('.cat__art .ln', cat);
    art.forEach((p) => {
      const len = p.getTotalLength ? p.getTotalLength() : 300;
      p.style.strokeDasharray = `${len} ${len}`;
      p.style.strokeDashoffset = len;
    });
    const tl = gsap.timeline({ scrollTrigger: { trigger: cat, start: 'top 82%', once: true } });
    tl.fromTo(cat, { '--line': 0 }, { '--line': 1, duration: 1.4, ease: 'expo.out' })
      .fromTo($$('.cat__aside > *', cat), { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 1, ease: 'expo.out', stagger: 0.07 }, 0.05)
      .to(art, { strokeDashoffset: 0, duration: 1.8, ease: 'power2.inOut', stagger: 0.12 }, 0.2)
      .fromTo($$('.item', cat), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.9, ease: 'expo.out', stagger: 0.045 }, 0.15);
  });

  // Onglets : catégorie active + défilement horizontal de la barre.
  const tabs = $$('.tab');
  const track = $('.tabs__track');
  function setTab(id) {
    tabs.forEach((t) => {
      const on = t.getAttribute('href') === '#' + id;
      t.classList.toggle('is-active', on);
      if (on && track) {
        const x = t.offsetLeft - track.clientWidth / 2 + t.clientWidth / 2;
        track.scrollTo({ left: x, behavior: 'smooth' });
      }
    });
  }
  $$('.cat').forEach((cat) => {
    ScrollTrigger.create({
      trigger: cat,
      start: 'top 45%',
      end: 'bottom 45%',
      onToggle: (st) => st.isActive && setTab(cat.id),
    });
  });

  /* ------------------------------------------------------------ menus */

  const MENUS = [
    {
      name: 'Menu 2',
      desc: 'Vingt pièces de maki, hosomaki et uramaki, avec une entrée et un dessert.',
      price: 35,
      feat: ['Miso soupe ou edamame', '12 hosomaki, 8 uramaki', 'Un dessert au choix'],
    },
    {
      name: 'Menu 1',
      desc: 'Cinq futomaki et six nigiri, avec une entrée et un dessert.',
      price: 42,
      feat: ['Miso soupe ou salade de calamar', '5 futomaki, 6 nigiri', 'Un dessert au choix'],
    },
    {
      name: 'Menu Fuji',
      desc: "L'assortiment complet : sashimi, nigiri, hosomaki et uramaki, avec une entrée et un dessert.",
      price: 50,
      feat: ['Miso soupe ou salade wakame', '6 sashimi, 5 nigiri, 6 hosomaki, 4 uramaki', 'Un dessert au choix'],
    },
  ];
  const mName = $('.menus__name span');
  const mDesc = $('.menus__desc');
  const mPrice = $('.menus__price');
  const mFeat = $$('.menus__feat li span');
  let menuIdx = 0;
  const priceObj = { v: MENUS[0].price };
  function setMenu(i) {
    if (i === menuIdx) return;
    menuIdx = i;
    const m = MENUS[i];
    $$('.menus__tab').forEach((b, k) => {
      b.classList.toggle('is-active', k === i);
      b.setAttribute('aria-selected', k === i ? 'true' : 'false');
    });
    gsap
      .timeline()
      .to(mName, { yPercent: -110, duration: 0.35, ease: 'power2.in' })
      .add(() => {
        mName.textContent = m.name;
        mDesc.textContent = m.desc;
        mFeat.forEach((s, k) => (s.textContent = m.feat[k]));
      })
      .fromTo(mName, { yPercent: 110 }, { yPercent: 0, duration: 0.7, ease: 'expo.out' })
      .fromTo(mDesc, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7, ease: 'expo.out' }, '<')
      .fromTo($$('.menus__feat li'), { opacity: 0, x: 16 }, { opacity: 1, x: 0, duration: 0.7, ease: 'expo.out', stagger: 0.06 }, '<');
    gsap.to(priceObj, {
      v: m.price,
      duration: 0.9,
      ease: 'power3.out',
      onUpdate: () => (mPrice.textContent = Math.round(priceObj.v) + '.–'),
    });
    if (scene) scene.setMenu(i);
  }
  $$('.menus__tab').forEach((b, k) => b.addEventListener('click', () => setMenu(k)));

  gsap.fromTo(
    '.menus__word',
    { scale: 0.86, opacity: 0.2 },
    { scale: 1, opacity: 1, ease: 'none', scrollTrigger: { trigger: '.menus', start: 'top bottom', end: 'top 20%', scrub: true } }
  );
  gsap.from(['.menus__tabs', '.menus__info', '.menus__feat'], {
    opacity: 0,
    y: 26,
    duration: 1.1,
    ease: 'expo.out',
    stagger: 0.1,
    scrollTrigger: { trigger: '.menus__tabs', start: 'top 85%', once: true },
  });
  gsap.fromTo(
    '.compare__table tr',
    { opacity: 0, y: 14 },
    { opacity: 1, y: 0, duration: 0.8, ease: 'expo.out', stagger: 0.06, scrollTrigger: { trigger: '.compare', start: 'top 85%', once: true } }
  );

  /* ---------------------------------------------------- menu du jour */

  gsap.fromTo(
    '.jour__item',
    { opacity: 0, y: 22 },
    { opacity: 1, y: 0, duration: 1, ease: 'expo.out', stagger: 0.07, scrollTrigger: { trigger: '.jour__list', start: 'top 85%', once: true } }
  );

  /* ------------------------------------------------------ à emporter */

  gsap.fromTo(
    '.emporter__word span',
    { xPercent: 14 },
    { xPercent: -14, ease: 'none', scrollTrigger: { trigger: '.emporter', start: 'top bottom', end: 'bottom top', scrub: 0.4 } }
  );
  $$('.count').forEach((el) => {
    const to = Number(el.dataset.to);
    const o = { v: 0 };
    gsap.to(o, {
      v: to,
      duration: 1.8,
      ease: 'power3.out',
      onUpdate: () => (el.textContent = Math.round(o.v)),
      scrollTrigger: { trigger: el, start: 'top 85%', once: true },
    });
  });
  revealOnEnter('.stat', { y: 40 });

  /* ------------------------------------------------------- horaires */

  // Horaires (aussi présents dans le tableau de index.html) — 0 = dimanche.
  const HOURS = {
    0: [['11:00', '14:00'], ['17:00', '21:00']],
    1: [['17:00', '21:30']],
    2: [['11:00', '14:00'], ['17:00', '21:30']],
    3: [['11:00', '14:00'], ['17:00', '21:30']],
    4: [['11:00', '14:00'], ['17:00', '21:30']],
    5: [['11:00', '14:00'], ['17:00', '22:00']],
    6: [['11:00', '14:00'], ['17:00', '22:00']],
  };
  const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  function zurichNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return { day, min: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  }
  function updateHours() {
    const { day, min } = zurichNow();
    $$('.hours__table tr').forEach((tr) => tr.classList.toggle('is-today', Number(tr.dataset.day) === day));
    const status = $('.hours__status');
    const label = $('.hours__now');
    const today = HOURS[day];
    const open = today.find(([a, b]) => min >= toMin(a) && min < toMin(b));
    if (open) {
      status.classList.add('is-open');
      label.textContent = `Ouvert maintenant — jusqu'à ${open[1]}`;
      return;
    }
    status.classList.remove('is-open');
    const later = today.find(([a]) => toMin(a) > min);
    if (later) {
      label.textContent = `Fermé — ouvre à ${later[0]}`;
      return;
    }
    for (let k = 1; k <= 7; k++) {
      const d = (day + k) % 7;
      if (HOURS[d].length) {
        label.textContent = `Fermé — ouvre ${k === 1 ? 'demain' : DAYS[d]} à ${HOURS[d][0][0]}`;
        return;
      }
    }
  }
  updateHours();
  setInterval(updateHours, 60000);

  revealOnEnter('.hours', { y: 30 });
  revealOnEnter('.coords > *', { y: 24 });

  /* ------------------------------------------------------------ footer */

  $$('.js-copy').forEach((b) => {
    b.addEventListener('click', async () => {
      const label = b.querySelector('.roll__in span') || b;
      const old = label.textContent;
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        label.textContent = 'Adresse copiée';
      } catch (e) {
        label.textContent = b.dataset.copy;
      }
      setTimeout(() => (label.textContent = old), 2200);
    });
  });
  $$('.js-year').forEach((el) => (el.textContent = new Date().getFullYear()));

  /* ------------------------------------------- navigation : lien actif */

  const navMap = [
    ['#intro', ['#intro', '#maki', '#bon-appetit']],
    ['#carte', ['.marquee', '#carte']],
    ['#menus', ['#menus', '#menu-du-jour']],
    ['#contact', ['#emporter', '#contact', '#footer']],
  ];
  const navLinks = $$('.nav__link');
  navMap.forEach(([href, sections]) => {
    sections.forEach((sel) => {
      ScrollTrigger.create({
        trigger: sel,
        start: 'top 50%',
        end: 'bottom 50%',
        onToggle: (st) => {
          if (!st.isActive) return;
          navLinks.forEach((l) => l.classList.toggle('is-active', l.getAttribute('href') === href));
        },
      });
    });
  });

  /* ------------------------------------------------------ halo du fond */

  // Halo chaud en bas à gauche pendant la séquence 3D, plus discret ensuite ;
  // une lueur en haut quand la pile de makis des menus est à l'écran.
  const glowEl = $('.backdrop__glow');
  const carteEl = $('#carte');
  const menusEl = $('#menus');
  ScrollTrigger.create({
    start: 0,
    end: 'max',
    onUpdate: () => {
      const vh = window.innerHeight;
      const s = getScroll();
      const g = clamp(s / vh, 0, 1) * (1 - clamp((s - carteEl.offsetTop + vh * 0.6) / vh, 0, 1));
      glowEl.style.setProperty('--glow', Math.max(g, 0.25).toFixed(3));
      const top = clamp(1 - Math.abs(s - menusEl.offsetTop) / (vh * 1.2), 0, 1);
      glowEl.style.setProperty('--glow-top', top.toFixed(3));
    },
  });

  /* ---------------------------------------------------------- curseur */

  const cursor = (function () {
    if (!finePointer) return null;
    const el = $('.cursor');
    const label = $('.cursor__label');
    let x = -100;
    let y = -100;
    let cx = x;
    let cy = y;
    let hand = false;
    let hoverEl = null;
    window.addEventListener(
      'pointermove',
      (e) => {
        x = e.clientX;
        y = e.clientY;
        el.classList.add('is-visible');
      },
      { passive: true }
    );
    document.addEventListener('pointerleave', () => el.classList.remove('is-visible'));
    gsap.ticker.add(() => {
      cx = lerp(cx, x, 0.24);
      cy = lerp(cy, y, 0.24);
      el.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
    });
    function refresh() {
      const t = hoverEl;
      el.classList.remove('is-link', 'is-label', 'is-hand');
      if (t && t.dataset.cursor) {
        label.textContent = t.dataset.cursor;
        el.classList.add('is-label');
      } else if (t) {
        el.classList.add('is-link');
      } else if (hand) {
        el.classList.add('is-hand');
      }
    }
    document.addEventListener('pointerover', (e) => {
      hoverEl = e.target.closest('[data-cursor], a, button, .item, .jour__item');
      refresh();
    });
    return {
      setHand(h) {
        if (h === hand) return;
        hand = h;
        refresh();
      },
    };
  })();

  // La scène suit le pointeur (parallaxe, survol de la main).
  window.addEventListener(
    'pointermove',
    (e) => {
      if (scene) scene.setPointer((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1), e.clientX, e.clientY);
    },
    { passive: true }
  );

  /* ------------------------------------------------ boutons magnétiques */

  if (finePointer) {
    $$('.magnetic').forEach((btn) => {
      const xTo = gsap.quickTo(btn, 'x', { duration: 0.6, ease: 'power3.out' });
      const yTo = gsap.quickTo(btn, 'y', { duration: 0.6, ease: 'power3.out' });
      btn.addEventListener('pointermove', (e) => {
        const r = btn.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * 0.3);
        yTo((e.clientY - (r.top + r.height / 2)) * 0.4);
      });
      btn.addEventListener('pointerleave', () => {
        gsap.to(btn, { x: 0, y: 0, duration: 1, ease: 'elastic.out(1, 0.4)' });
      });
    });

    // Inclinaison 3D au survol (via GSAP pour ne pas écraser ses autres transformations).
    $$('[data-tilt]').forEach((card) => {
      gsap.set(card, { transformPerspective: 700 });
      const rx = gsap.quickTo(card, 'rotationX', { duration: 0.6, ease: 'power3.out' });
      const ry = gsap.quickTo(card, 'rotationY', { duration: 0.6, ease: 'power3.out' });
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        rx(-((e.clientY - r.top) / r.height - 0.5) * 8);
        ry(((e.clientX - r.left) / r.width - 0.5) * 10);
      });
      card.addEventListener('pointerleave', () => {
        rx(0);
        ry(0);
      });
    });
  }

  /* ---------------------------------------------------------- resize */

  ScrollTrigger.addEventListener('refresh', () => scene && scene.layout());

  // Outils de test : index.html?debug
  if (/[?&]debug\b/.test(location.search)) {
    window.__fuji = {
      get scene() {
        return scene;
      },
      lenis,
      ScrollTrigger,
      jump(y) {
        if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
        else window.scrollTo(0, y);
        ScrollTrigger.update();
      },
    };
  }
  let rTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rTimer);
    rTimer = setTimeout(() => {
      if (scene) scene.resize();
      ScrollTrigger.refresh();
    }, 150);
  });
})();
