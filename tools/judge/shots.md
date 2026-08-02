# The shot list

Every judging round uses the same eight frames, so rounds can be compared to
each other rather than to a memory. Load `http://localhost:8173/`, wait for the
world to build, then:

```js
document.getElementById('title').classList.add('hidden');
diku.state.paused = false;
```

| # | Name | Camera | Time | What it is testing |
|---|---|---|---|---|
| 1 | `street-dusk` | `diku.goto(3005, 0.15, -0.02)` | dusk | The establishing shot: street frontage, receding perspective, warm light |
| 2 | `market-backlit` | `diku.goto(3014, 2.5, -0.02)` | dusk | Backlit silhouettes, bloom discipline, shadow length |
| 3 | `temple-interior` | `diku.goto(3001, Math.PI, 0)` | dusk | Interior light falloff, torches, material response in shade |
| 4 | `alley` | `diku.goto(3013, 1.6, -0.05)` | dusk | Narrow space, ambient occlusion, contact between wall and ground |
| 5 | `market-noon` | `diku.goto(3014, 2.5, -0.02)` | noon | Hard light, does it hold up without golden hour flattering it |
| 6 | `temple-night` | `diku.goto(3005, 0.15, -0.02)` | night | Emissive windows, lamps, whether the town still reads |
| 7 | `wall-detail` | `diku.look(x, y, z, yaw, 0)` two metres from a house front | dusk | Texture at close range: tiling, normal strength, sharpness |
| 8 | `person` | three metres from a mobile, eye level | dusk | The weakest link historically — silhouette, proportion, materials |

Set the time with `diku.applyTime('dusk' | 'noon' | 'night')`. Save each frame
with the screenshot tool's `filePath` to `tools/judge/round-<n>/<name>.png`.

## What the judge is asked

The judge is an independent agent. It has never seen the code and is not told
what was changed. It is given the eight frames and asked to compare them against
named references it looks up itself — Kingdom Come: Deliverance, Assassin's
Creed Unity, The Witcher 3's Novigrad, and photographs of Rothenburg ob der
Tauber and Colmar at golden hour — and to return specific, actionable faults
ranked by how much they cost the illusion.

The judge's prompt is never softened to make a round pass. If a round fails, the
work changes, not the question.
