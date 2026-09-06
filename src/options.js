/**
 * The options screen. Press O.
 *
 * Two things live here that used to be hard-coded. The frame-rate target,
 * because the whole point of capping it is that you can choose where to cap;
 * and the individual detail dials, because a preset is a guess about your
 * machine and this is not. Everything is stored in localStorage and applied the
 * moment you change it, so you can watch the GPU figure move while you do it.
 *
 * It builds its own DOM and styles so index.html stays a page, not a settings
 * dialog. The look follows the rest of the interface: serif on dark, gold rules.
 */

const STORE = 'diku3d.options';

/**
 * null means "leave it to the preset"; anything else overrides it.
 *
 * The default is `high` rather than `medium` because `medium` was chosen back
 * when the frame cap was 60, and it bought its coolness by switching off the
 * two things that do most for how close range looks: ambient occlusion, and
 * the fine detail normal. At 30 fps there are 33 ms in a frame and `high`
 * spends about six of them, so the caution it was protecting has expired.
 * Anyone who wants the old behaviour still has `medium` on this screen.
 */
export const DEFAULTS = {
  targetFps: 30,
  preset: 'high',
  renderScale: 'auto',
  ao: null,
  shafts: null,
  shadow: null,
  bloom: null,
  lights: null,
  time: 'dusk',
  weather: 'clear',
  sound: true,
};

const FIELDS = [
  {
    key: 'targetFps',
    label: 'Frame rate',
    note: 'The single biggest lever on how warm the machine gets. Half the frames is half the work.',
    options: [[30, '30'], [60, '60'], [120, '120'], [0, 'uncapped']],
  },
  {
    key: 'preset',
    label: 'Detail',
    note: 'A starting point for everything below it.',
    options: [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'max']],
  },
  {
    key: 'renderScale',
    label: 'Resolution',
    note: 'Auto drops a step when a frame threatens its budget, measured on the GPU.',
    options: [['auto', 'auto'], [0, '55%'], [1, '70%'], [2, '85%'], [3, '100%']],
  },
  {
    key: 'ao',
    label: 'Ambient occlusion',
    note: 'Contact darkening where surfaces meet. The cheapest thing that makes geometry sit in a scene.',
    options: [[null, 'preset'], [false, 'off'], ['low', 'on'], ['high', 'high']],
  },
  {
    key: 'shafts',
    label: 'Light shafts',
    note: 'Sunbeams down a street when the sun is low. Costs only when you face it.',
    options: [[null, 'preset'], [false, 'off'], ['low', 'on'], ['high', 'high']],
  },
  {
    key: 'shadow',
    label: 'Shadow detail',
    note: 'Map size. The sun is only redrawn when you cross a six-metre line, so this is nearly free.',
    options: [[null, 'preset'], [0, 'off'], [2048, '2048'], [3072, '3072'], [4096, '4096']],
  },
  {
    key: 'bloom',
    label: 'Bloom',
    note: null,
    options: [[null, 'preset'], [false, 'off'], ['half', 'half'], ['full', 'full']],
  },
  {
    key: 'lights',
    label: 'Torches lit at once',
    note: 'How many of the hundreds of flames are real lights. The rest still glow.',
    options: [[null, 'preset'], [6, '6'], [10, '10'], [14, '14'], [20, '20']],
  },
  {
    key: 'time',
    label: 'Time of day',
    note: null,
    options: [['dawn', 'dawn'], ['noon', 'noon'], ['dusk', 'dusk'], ['night', 'night']],
  },
  {
    key: 'weather',
    label: 'Weather',
    note: "Auto is the mud's own weather: a barometer wandering between four sky states, a mud hour every forty seconds, announced in the log the way a player would read it.",
    options: [['auto', 'auto'], ['clear', 'clear'], ['overcast', 'overcast']],
  },
  {
    key: 'sound',
    label: 'Sound',
    note: null,
    options: [[true, 'on'], [false, 'off']],
  },
];

const AO_LEVELS = {
  low: { scale: 0.4, samples: 9, denoise: 4 },
  high: { scale: 0.5, samples: 12, denoise: 8 },
};
const SHAFT_LEVELS = {
  low: { scale: 0.3, samples: 16 },
  high: { scale: 0.4, samples: 24 },
};

const CSS = `
#options {
  position: fixed; inset: 0; z-index: 40; display: none;
  align-items: center; justify-content: center;
  background: rgba(6, 6, 9, 0.72); backdrop-filter: blur(6px);
  font-family: var(--serif); color: var(--ink);
}
#options.open { display: flex; }
#options-panel {
  width: min(720px, 88vw); max-height: 86vh; overflow-y: auto;
  background: rgba(14, 12, 10, 0.94); border: 1px solid var(--edge);
  padding: 30px 34px 26px; border-radius: 3px;
}
#options h2 {
  margin: 0 0 4px; font-size: 26px; font-weight: 400; letter-spacing: 0.02em;
}
#options .sub {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--gold); opacity: 0.72; margin-bottom: 22px;
}
#options .row { padding: 11px 0; border-top: 1px solid rgba(224,189,119,0.13); }
#options .row:first-of-type { border-top: none; }
#options .row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
#options .row-label { font-size: 16px; }
#options .row-note {
  font-size: 12.5px; line-height: 1.5; opacity: 0.5; margin-top: 4px; max-width: 60ch;
}
#options .choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
#options button.choice {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em;
  padding: 6px 13px; border-radius: 2px; cursor: pointer;
  background: rgba(255,255,255,0.05); color: var(--ink);
  border: 1px solid rgba(224,189,119,0.22);
}
#options button.choice:hover { background: rgba(224,189,119,0.14); }
#options button.choice.on {
  background: var(--gold); color: #100e0b; border-color: var(--gold);
}
#options-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 20px; padding-top: 14px; border-top: 1px solid rgba(224,189,119,0.13);
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; opacity: 0.55;
}
#options-cost { color: var(--gold); opacity: 0.9; }
#options-foot button {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.14em;
  background: none; border: 1px solid rgba(224,189,119,0.3); color: var(--ink);
  padding: 7px 16px; border-radius: 2px; cursor: pointer;
}
`;

export function createOptions({ quality, applyTime, applyWeather, audio, state }) {
  const stored = load();
  const values = { ...DEFAULTS, ...stored };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'options';
  root.innerHTML = `<div id="options-panel">
    <h2>Options</h2>
    <div class="sub">O to close · settings are remembered</div>
    <div id="options-rows"></div>
    <div id="options-foot">
      <span id="options-cost">measuring…</span>
      <button id="options-reset">reset to defaults</button>
    </div>
  </div>`;
  document.body.appendChild(root);

  const rows = root.querySelector('#options-rows');
  const buttons = new Map();

  for (const field of FIELDS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="row-head"><span class="row-label">${field.label}</span></div>`
      + (field.note ? `<div class="row-note">${field.note}</div>` : '')
      + '<div class="choices"></div>';
    const choices = row.querySelector('.choices');
    const made = [];
    for (const [value, label] of field.options) {
      const button = document.createElement('button');
      button.className = 'choice';
      button.textContent = label;
      button.addEventListener('click', () => {
        values[field.key] = value;
        save(values);
        apply();
        paint();
      });
      choices.appendChild(button);
      made.push({ button, value });
    }
    buttons.set(field.key, made);
    rows.appendChild(row);
  }

  root.querySelector('#options-reset').addEventListener('click', () => {
    Object.assign(values, DEFAULTS);
    save(values);
    apply();
    paint();
  });

  function paint() {
    for (const [key, made] of buttons) {
      for (const { button, value } of made) {
        button.classList.toggle('on', Object.is(values[key], value));
      }
    }
  }

  /** Translate the screen's vocabulary into what Quality actually wants. */
  function apply() {
    const overrides = {};
    if (values.targetFps !== null) overrides.fps = values.targetFps;
    if (values.ao !== null) overrides.ao = values.ao === false ? false : AO_LEVELS[values.ao];
    if (values.shafts !== null) overrides.shafts = values.shafts === false ? false : SHAFT_LEVELS[values.shafts];
    if (values.shadow !== null) overrides.shadow = values.shadow;
    if (values.bloom !== null) overrides.bloom = values.bloom;
    if (values.lights !== null) overrides.lights = values.lights;

    quality.overrides = overrides;
    quality.apply(values.preset);
    quality.setScale(values.renderScale === 'auto' ? null : values.renderScale);

    if (values.time !== state.time) applyTime(values.time);
    // Against the *mode*, not the rendered sky: under 'auto' the two differ by
    // design, and comparing them would rebake the environment on every apply.
    if (values.weather !== state.weatherMode) applyWeather(values.weather);
    if (audio.muted === values.sound) audio.toggleMute();
  }

  let costTimer = 0;
  return {
    values,
    toggle() {
      root.classList.toggle('open');
      return root.classList.contains('open');
    },
    get open() { return root.classList.contains('open'); },
    close() { root.classList.remove('open'); },
    /** Applied once at boot, after the renderer and audio exist. */
    start() { apply(); paint(); },
    update(dt) {
      if (!root.classList.contains('open')) return;
      costTimer -= dt;
      if (costTimer > 0) return;
      costTimer = 0.4;
      const fps = quality.preset.fps || 120;
      const ms = quality.gpuMs;
      root.querySelector('#options-cost').textContent = ms === null
        ? 'measuring…'
        : `${ms.toFixed(1)} ms of GPU per frame · about ${Math.round(ms * fps / 10)}% busy at ${fps} fps`;
    },
  };
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}

function save(values) {
  try {
    localStorage.setItem(STORE, JSON.stringify(values));
  } catch {
    /* private browsing: the settings simply don't persist */
  }
}
