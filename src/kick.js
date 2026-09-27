/**
 * The kick you see: fight.c's do_kick from behind your own eyes.
 *
 * There is no clip for it -- the first-person view is a pair of hands -- so
 * it is procedural: a leg in a boot comes up from below the frame, drives
 * forward to meet the blow the game has already resolved (its `delay`), and
 * comes back down, with the view dipping onto the planted foot. It rides in
 * fx.js's view-model scene, so it is lit by the same lights as the blade and
 * drawn over the world the same way.
 */

import * as THREE from 'three';

const ease = (u) => u * u * (3 - 2 * u);
const easeOut = (u) => 1 - (1 - u) * (1 - u);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A trouser leg and a boot, hip at the origin, the leg hanging down -Y. */
function buildLeg(library) {
  const leather = library ? library.materialFor('leather') : new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.6 });
  const cloth = library ? library.materialFor('cloth') : new THREE.MeshStandardMaterial({ color: 0x5b4a40, roughness: 0.95 });
  const tinted = (geometry, hex) => {
    const n = geometry.attributes.position.count;
    const c = new Float32Array(n * 3);
    const colour = new THREE.Color(hex);
    for (let i = 0; i < n; i++) { c[i * 3] = colour.r; c[i * 3 + 1] = colour.g; c[i * 3 + 2] = colour.b; }
    geometry.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geometry;
  };
  const leg = new THREE.Group();
  const trouser = new THREE.Mesh(tinted(new THREE.CylinderGeometry(0.085, 0.07, 0.72, 14), 0x6b5a4c), cloth);
  trouser.position.y = -0.36;
  const shaft = new THREE.Mesh(tinted(new THREE.CylinderGeometry(0.068, 0.062, 0.3, 14), 0x8a6444), leather);
  shaft.position.y = -0.82;
  const cuff = new THREE.Mesh(tinted(new THREE.TorusGeometry(0.07, 0.014, 6, 16), 0x6e4e34), leather);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.y = -0.68;
  // The foot: toe forward (-Z) out of the ankle, a sole a shade darker.
  const foot = new THREE.Mesh(tinted(new THREE.CapsuleGeometry(0.058, 0.17, 4, 12), 0x8a6444), leather);
  foot.rotation.x = Math.PI / 2;
  foot.position.set(0, -0.95, -0.07);
  const sole = new THREE.Mesh(tinted(new THREE.BoxGeometry(0.11, 0.025, 0.3), 0x5a4230), leather);
  sole.position.set(0, -1.005, -0.075);
  leg.add(trouser, shaft, cuff, foot, sole);
  leg.traverse((n) => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = false; n.frustumCulled = false; } });
  return leg;
}

export function createKick({ fx, camera, game, audio }) {
  const vm = fx.viewModel;
  const hip = new THREE.Group();
  // Below and a touch right of the eye: where your own right hip is.
  hip.position.set(0.12, -0.9, 0.05);
  const leg = buildLeg(vm.library);
  hip.add(leg);
  hip.visible = false;
  vm.root.add(hip);

  let kick = null;
  game.listen((event) => {
    if (event.kind !== 'kick') return;
    // Contact on the beat of the blow the rules resolved: rules/skills.js's WINDUP.
    kick = { t: 0, contact: 0.28, hold: 0.07, back: 0.34 };
  });

  function update(dt) {
    if (!kick) { hip.visible = false; return; }
    kick.t += dt;
    const { t, contact, hold, back } = kick;
    let lift;       // 0 hanging, 1 horizontal
    if (t < contact) lift = easeOut(t / contact);
    else if (t < contact + hold) lift = 1;
    else lift = 1 - ease(clamp((t - contact - hold) / back, 0, 1));
    if (t > contact + hold + back) { kick = null; hip.visible = false; return; }
    hip.visible = true;
    // The swing is about the hip, up past level -- from behind your own eyes a
    // kick only enters the frame once the foot is at the height of a belt --
    // and a little across the body, sole first.
    hip.rotation.set(lift * 2.3, 0, -0.12 * lift);
    // The view pitches down onto the planted foot and back.
    const dip = Math.sin(clamp(t / (contact + hold + back), 0, 1) * Math.PI) * 0.035;
    vm.root.position.y -= dip;
    void camera; void audio;
  }

  return { update, hip };
}
