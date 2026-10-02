# Scenery for an introduction film

Rooms worth filming, for a scenery reel or intro film that is still to be made.
Every place comes out of the stock area files; the vnum is all you need to get
there. The time of day is the one each place looks best at, as seen during
the judging rounds (LEARNINGS.md).

## Getting a shot

In the browser console (F12), on `http://localhost:8173/`:

```js
diku.goto(3054)                 // stand in a room; diku.goto(vnum, yaw, pitch) to aim
diku.applyTime('dusk')          // 'dawn' | 'noon' | 'dusk' | 'night'
diku.shoot('nomansland')        // a framed view of a kind of place (diku.places() lists them)
diku.state.paused = false       // move without grabbing the mouse
```

Or straight from the URL: `?room=3054&time=dusk`. `V` toggles noclip for
camera moves through walls. The camera looks down -Z at yaw 0; to stand at an
offset `(ox, oz)` from a subject and face it, `yaw = Math.atan2(ox, oz)`.

`src/title.js` already flies a six-shot reel behind the title screen (3014,
3005, 3040, 5056, 7030, 3600, all at dusk) and is the place to start from:
each shot there is a `from`/`to` camera path and an `aim` point relative to the
room.

## The list

| vnum | what | best at |
|---|---|---|
| 3001 | Temple of Midgaard: painted murals of gods, giants and peasants, the town framed through the gate | dusk |
| 3054 | The temple altar with the seated Odin, his ravens and wolves | — |
| 3014 | Market Square with the Midgaard Worm on its plinth | noon |
| 3005 | Temple Square: the fountain, the temple on its mound behind the marble steps | night |
| 3052 / 6000 | The West Gate's towers and footbridge; 6000 looks at it from the forest | — |
| 3019 | Mage's Laboratory: alchemy tables, pentagrams, blackboard | — |
| 3106 | Park Cafe, a log-built interior | — |
| 3007 | The Grunting Boar, an inn with a bar and seated guests | evening |
| 3143 | The jail with its iron door | — |
| 6128 / 6104 | Haon Dor: deep forest of Douglas fir and cedar | — |
| 6153 | Inside the hollow great tree (6152 is the tree from outside) | — |
| 6112 | The green dragon | — |
| 1113 / 1133 | The Shire: Bywater Road, a lane of smials and round doors | dusk |
| 1144 | The Green Dragon, the halflings' inn | — |
| 1142 | The barn: horses and cows grazing | — |
| 3604 / 3650 | The graveyard by moonlight | night |
| 3645 | A tomb with burial niches and a sarcophagus | — |
| 7009 | The sewer junction, brick barrel vaults | — |
| 7201 | The octagonal lair of purple stone | — |
| 7284 | "The firedeath", a room of fire | — |
| 7280 | The entrance, stone faces in the walls | — |
| 7428 | The dragon's lair: glowing floor, the red dragon | — |
| 7285 | The torture room | — |
| 5056 | The nomad camp at the oasis | dusk |
| 5028 | The desert: the sand worm, the mesas | — |
| 5021 | The temple of the myconoids, the mushroom people | — |
| 2133 | No Man's Land with the gangs' watch fires | night |
| 2153 | What is left of the weaponshop | — |
| 8318 | The marsh before the fortress, drawbridge up | — |
| 8313 | The obsidian monolith | — |
| 8308 | The marsh with the Will-O-Wisp | night |
| 2803 | The troll den | — |
