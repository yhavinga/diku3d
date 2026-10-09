// assets/title-still.webp: the title reel's first shot (src/title.js SHOTS[0])
// at the start of its dolly, which the title shows until the world is built.
// Wide on purpose: at the camera's vertical field of view a 2560x1080 frame
// cropped to any narrower screen is what the reel will show there.
//
//   node /tmp/pw/drive.mjs --nohide --wait 3000 --size 2560x1080 --script tools/judge/headless/title-still.js
//   cwebp -q 60 -m 6 /tmp/title-still.png -o assets/title-still.webp
//
// The reel stays running so the HUD and the fists stay hidden; its update
// is replaced to hold the camera still, and the title card is hidden by
// style rather than class, since the class would end the reel.
const d = diku;
const c = d.built.rooms.get(3014).center;
const EYE = 1.72;
const from = { x: c.x - 7, y: c.y + 0.5 + EYE, z: c.z + 10 };
const aim = { x: c.x + 5, y: c.y + 3, z: c.z - 10 };
d.title.update = () => {
  d.camera.position.set(from.x, from.y, from.z);
  const dx = aim.x - from.x, dz = aim.z - from.z;
  d.camera.rotation.set(Math.atan2(aim.y - from.y, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0);
  d.camera.updateMatrixWorld();
};
d.title.update();
d.built.horizon?.settle(d.camera.position);
document.getElementById('title').style.visibility = 'hidden';
await new Promise((r) => setTimeout(r, 5000));
await __shot('/tmp/title-still.png');
return '/tmp/title-still.png';
