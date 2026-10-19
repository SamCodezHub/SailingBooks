/* Colours and backgrounds, kept apart.
 *
 * A colour theme says what everything is drawn in. A background says what is
 * behind it - plain, ruled, dotted, and so on. They used to be one thing, which
 * meant picking a colour also silently picked a pattern behind it, and there
 * were nine of them.
 *
 * The palettes are built here rather than written out as hundreds of blocks of
 * CSS: each one is named and seeded, and the rest of its shades are worked out
 * from the seed. Muted text in particular is measured against the background and
 * darkened or lightened until it can actually be read, so adding a theme can
 * never quietly produce text nobody can read.
 */
(function () {
  'use strict';

  /* ---- colour, just enough of it ---- */
  function hex(h) {
    const s = String(h).replace('#', '');
    const full = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  function toHex(rgb) {
    return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
  function luminance(c) {
    const [r, g, b] = hex(c).map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const ratio = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const isDark = c => luminance(c) < 0.4;
  // Walk a colour towards the far end of its own background until it can be read.
  function readable(ink, bg, floor) {
    if (ratio(ink, bg) >= floor) return ink;
    const target = isDark(bg) ? '#ffffff' : '#000000';
    let best = ink;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      best = mix(ink, target, t);
      if (ratio(best, bg) >= floor) return best;
    }
    return target;
  }

  /* ---- hsl, so a seed can be a hue and a depth rather than four hex codes ---- */
  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
    return toHex(seg.map(v => (v + m) * 255));
  }

  /* A palette, worked out from a seed. Everything the app draws takes its colour
     from one of these names, so a theme is really just a handful of decisions
     made once here. */
  function palette(name, bg, ink, accent, opts) {
    const o = opts || {};
    const dark = isDark(bg);
    const panel = o.panel || mix(bg, ink, dark ? 0.05 : 0.025);
    const soft = mix(bg, ink, dark ? 0.11 : 0.055);
    const line = mix(bg, ink, dark ? 0.18 : 0.10);
    const edge = mix(bg, ink, dark ? 0.34 : 0.22);
    // Held to 4.5:1 against the panel, which is what text actually sits on.
    const muted = readable(mix(ink, bg, dark ? 0.40 : 0.34), panel, 4.5);
    const faint = mix(muted, bg, 0.32);
    const strong = mix(ink, bg, dark ? 0 : 0.06);
    const onAccent = readable('#ffffff', accent, 3.2);
    return {
      id: o.id, name,
      vars: {
        '--bg': bg, '--panel': panel, '--panel-2': soft, '--soft': soft, '--chip': mix(bg, ink, dark ? 0.16 : 0.08),
        '--track': soft, '--reader-bg': o.reader || bg, '--pdf-bg': soft, '--scrim': mix(bg, '#ffffff', dark ? 0.10 : 0.30),
        '--dim': mix(bg, ink, dark ? 0.45 : 0.18),
        '--ink': ink, '--strong': strong, '--text': mix(ink, bg, dark ? 0.04 : 0.02),
        '--muted': muted, '--faint': faint,
        '--line': line, '--hover': edge, '--accent': accent, '--on-accent': onAccent,
        '--danger': readable(o.danger || '#c0392b', panel, 4.5), '--focus': o.focus || accent, '--edge': edge,
        '--shadow': dark ? '0 1px 2px rgba(0,0,0,.5), 0 10px 30px rgba(0,0,0,.45)' : '0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.06)',
        '--shadow-lg': dark ? '0 14px 44px rgba(0,0,0,.6)' : '0 12px 40px rgba(0,0,0,.14)'
      },
      sw: [bg, panel, accent]
    };
  }

  /* ---- the seeds ----
   * Each is a hue, how deep it is, and how bright its accent should be. Turning
   * one into a theme is then arithmetic rather than taste, which is what makes a
   * couple of hundred of them consistent. */
  const SEEDS = [
    ['Arch', 38, 'warm', 28], ['Aurora', 155, 'cool', 62], ['Beach', 195, 'light', 62],
    ['Bento', 12, 'warm', 70], ['Bingsu', 285, 'cool', 74], ['Bliss', 330, 'warm', 66],
    ['Blue Dolphin', 214, 'cool', 70], ['Blueberry Dark', 232, 'dark', 66], ['Blueberry Light', 228, 'light', 70],
    ['Botanical', 138, 'cool', 62], ['Bouquet', 344, 'warm', 70], ['Breeze', 196, 'light', 66],
    ['Bushido', 6, 'dark', 62], ['Cafe', 26, 'warm', 62], ['Camping', 96, 'cool', 58],
    ['Carbon', 220, 'dark', 58], ['Catppuccin', 268, 'cool', 76], ['Chaos Theory', 300, 'dark', 70],
    ['Cheesecake', 44, 'light', 68], ['Cherry Blossom', 340, 'light', 70], ['Comfy', 28, 'warm', 66],
    ['Copper', 20, 'dark', 68], ['Creamsicle', 32, 'light', 72], ['Crimson', 352, 'dark', 66],
    ['Cyber', 186, 'dark', 62], ['Dawn', 22, 'light', 66], ['Deep Sea', 202, 'dark', 62],
    ['Desert', 38, 'light', 60], ['Dune', 42, 'warm', 64], ['Emerald', 158, 'dark', 66],
    ['Fjord', 198, 'dark', 66], ['Forest', 142, 'dark', 62], ['Frost', 200, 'light', 62],
    ['Galaxy', 262, 'dark', 74], ['Garden', 120, 'light', 58], ['Glacier', 188, 'light', 66],
    ['Grape', 278, 'cool', 70], ['Graphite', 220, 'dark', 58], ['Grove', 132, 'cool', 60],
    ['Harbour', 200, 'cool', 62], ['Hazel', 30, 'warm', 62], ['Horizon', 348, 'light', 68],
    ['Indigo', 246, 'dark', 72], ['Ivory', 40, 'light', 60], ['Jade', 160, 'cool', 62],
    ['Juniper', 168, 'cool', 58], ['Kelp', 150, 'dark', 66], ['Kiwi', 96, 'light', 62],
    ['Lagoon', 186, 'cool', 66], ['Lavender', 270, 'light', 70], ['Lemon', 52, 'light', 66],
    ['Lichen', 84, 'cool', 62], ['Lighthouse', 46, 'warm', 68], ['Lupine', 250, 'cool', 72],
    ['Magenta', 318, 'dark', 72], ['Mango', 32, 'light', 68], ['Maple', 18, 'warm', 64],
    ['Marine', 204, 'dark', 66], ['Meadow', 112, 'light', 60], ['Midnight', 226, 'dark', 66],
    ['Mineral', 176, 'cool', 64], ['Mint', 160, 'light', 64], ['Mocha', 24, 'warm', 64],
    ['Moss', 126, 'cool', 60], ['Mulberry', 320, 'cool', 70], ['Nautilus', 208, 'dark', 66],
    ['Nimbus', 220, 'light', 64], ['Nomad', 36, 'warm', 66], ['Obsidian', 240, 'dark', 66],
    ['Ocean', 190, 'dark', 66], ['Olive', 74, 'warm', 60], ['Onyx', 230, 'dark', 58],
    ['Orchid', 296, 'light', 72], ['Ochre', 44, 'warm', 62], ['Olive Grove', 92, 'cool', 60],
    ['Peach', 22, 'light', 70], ['Petal', 340, 'light', 72], ['Pine', 152, 'dark', 66],
    ['Plum', 312, 'cool', 70], ['Polaris', 214, 'light', 64], ['Poppy', 8, 'warm', 68],
    ['Prairie', 48, 'light', 60], ['Prism', 292, 'cool', 74], ['Quartz', 210, 'light', 62],
    ['Rainforest', 140, 'dark', 66], ['Raven', 224, 'dark', 62], ['Rose', 346, 'light', 70],
    ['Ruby', 350, 'dark', 68], ['Rust', 16, 'warm', 66], ['Sage', 128, 'light', 62],
    ['Sail', 196, 'cool', 64], ['Salt', 200, 'light', 58], ['Sandal', 30, 'warm', 62],
    ['Sapphire', 218, 'dark', 70], ['Satin', 330, 'light', 62], ['Savanna', 44, 'warm', 64],
    ['Sepia', 34, 'warm', 60], ['Slate', 212, 'dark', 64], ['Solar', 46, 'light', 66],
    ['Spruce', 146, 'dark', 62], ['Steel', 206, 'cool', 62], ['Stone', 36, 'light', 58],
    ['Storm', 220, 'dark', 66], ['Sugar', 340, 'light', 72], ['Tangerine', 26, 'warm', 70],
    ['Tide', 194, 'cool', 66], ['Topaz', 42, 'light', 66], ['Truffle', 24, 'dark', 66],
    ['Twilight', 258, 'cool', 74], ['Ultramarine', 234, 'cool', 72], ['Umber', 28, 'dark', 64],
    ['Verdant', 134, 'cool', 64], ['Vermilion', 14, 'warm', 70], ['Violet', 274, 'cool', 74],
    ['Willow', 108, 'cool', 60], ['Wine', 340, 'dark', 68], ['Zinc', 210, 'cool', 60]
  ];

  /* Nine of the old names, kept as they were, so a saved setting still means
     what it meant. */
  const HANDMADE = [
    { id: 'light', name: 'Light', bg: '#ffffff', ink: '#1a1a1a', accent: '#1a1a1a' },
    { id: 'paper', name: 'Paper', bg: '#f6efe1', ink: '#3b3226', accent: '#3b3226' },
    { id: 'solar', name: 'Solar', bg: '#fdf6e3', ink: '#26221a', accent: '#268bd2' },
    { id: 'mono', name: 'Mono', bg: '#f2f2f2', ink: '#1c1c1c', accent: '#1c1c1c' },
    { id: 'midnight', name: 'Midnight', bg: '#14161d', ink: '#e8e9ee', accent: '#6d8cff' },
    { id: 'dusk', name: 'Dusk', bg: '#191526', ink: '#ece8f6', accent: '#b388ff' },
    { id: 'ocean', name: 'Ocean', bg: '#07222b', ink: '#e6f4f6', accent: '#2dd4bf' },
    { id: 'forest', name: 'Forest', bg: '#101a13', ink: '#e9f0e8', accent: '#86c06a' },
    { id: 'ink', name: 'Ink', bg: '#000000', ink: '#f2f2f2', accent: '#ffd166' }
  ];

  const DEPTHS = {
    light: { bgS: 96, bgL: 96, inkS: 26, inkL: 22 },
    soft: { bgS: 34, bgL: 92, inkS: 30, inkL: 24 },
    dark: { bgS: 30, bgL: 10, inkS: 24, inkL: 92 }
  };

  const THEMES = [];
  const seen = new Set();
  function add(p) {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    THEMES.push(p);
  }
  for (const h of HANDMADE) {
    add(palette(h.name, h.bg, h.ink, h.accent, { id: h.id }));
  }
  for (const [name, hue, depth, accentL] of SEEDS) {
    for (const variant of ['light', 'dark']) {
      const d = DEPTHS[variant];
      const bg = hsl(hue, d.bgS, d.bgL);
      const ink = hsl(hue, d.inkS, d.inkL);
      const accent = hsl((hue + (variant === 'dark' ? 40 : 18)) % 360, variant === 'dark' ? 68 : 62, accentL);
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + (variant === 'dark' ? '-dark' : '-light');
      add(palette(name + (variant === 'dark' ? ' Dark' : ''), bg, ink, accent, { id, reader: bg }));
    }
  }

  /* ---- backgrounds: what is behind the words ----
   * Deliberately separate from the colours, so changing the colour of the text
   * never silently changes the pattern behind it. */
  const BACKGROUNDS = [
    { id: 'plain', name: 'Plain', css: 'none' },
    { id: 'ruled', name: 'Ruled', css: 'repeating-linear-gradient(0deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 34px)' },
    { id: 'grid', name: 'Grid', css: 'repeating-linear-gradient(0deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 34px), repeating-linear-gradient(90deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 34px)' },
    { id: 'dots', name: 'Dots', css: 'radial-gradient(var(--sb-line) 1px, transparent 1.5px)', size: '22px 22px' },
    { id: 'fine-dots', name: 'Fine dots', css: 'radial-gradient(var(--sb-line) 1px, transparent 1.5px)', size: '12px 12px' },
    { id: 'diagonal', name: 'Diagonal', css: 'repeating-linear-gradient(135deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 9px)' },
    { id: 'crosshatch', name: 'Crosshatch', css: 'repeating-linear-gradient(45deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 9px), repeating-linear-gradient(-45deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 9px)' },
    { id: 'paper-fibre', name: 'Paper fibre', css: 'repeating-linear-gradient(112deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 7px)' },
    { id: 'glow', name: 'Glow', css: 'radial-gradient(circle at 12% 0%, var(--sb-glow), transparent 46%), radial-gradient(circle at 100% 100%, var(--sb-glow), transparent 42%)' },
    { id: 'corner', name: 'Corner light', css: 'radial-gradient(circle at 100% 0%, var(--sb-glow), transparent 38%)' },
    { id: 'pinstripe', name: 'Pinstripe', css: 'repeating-linear-gradient(90deg, var(--sb-line) 0, var(--sb-line) 1px, transparent 1px, transparent 16px)' },
    { id: 'shelf', name: 'Shelf edge', css: 'repeating-linear-gradient(0deg, transparent 0, transparent 39px, var(--sb-line) 39px, var(--sb-line) 40px)' }
  ];

  const byId = list => id => list.find(x => x.id === id) || null;
  const findTheme = byId(THEMES);
  const findBackground = byId(BACKGROUNDS);

  window.SB_THEMES = THEMES;
  window.SB_BACKGROUNDS = BACKGROUNDS;
  window.SB_findTheme = findTheme;
  window.SB_findBackground = findBackground;
  // Used by the checks, so a theme can be measured without a browser guessing.
  window.SB_contrast = ratio;
  window.SB_palette = palette;
})();
