// Every place that names the extension engine's version names the same one.
//
// Suwayomi migrates its own database forward when a newer version starts on it, and an older one does not read
// what a newer one wrote. The engine's data is the same data wherever it runs: a Compose volume moved to the
// Unraid template, a CasaOS add-on. So "switching setups never downgrades the engine" (#72) holds only while every
// pin moves together -- and before this test nothing made them. The pin is written in the four compose files, the
// CasaOS add-on, the Unraid engine template and the web's setup steps; the fake engine's schema is captured from
// it, and the server's own TESTED_ENGINE (enginePin.ts, what Health compares a running engine with) names it.
//
// The list is scripts/engine/pins.json, shared with scripts/engine/bump.mjs, which moves every one of them for a new
// engine (the weekly canary runs it on a branch). The pin file (scripts/engine/pin.json) is the reference: it is
// what every install runs. Everything else is held equal to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ENGINE_PINS_REPO: another checkout to hold to the same rules -- engineCanaryScripts.test.ts runs this file on a
// temporary copy that scripts/engine/bump.mjs has just moved to a new engine.
const REPO = process.env.ENGINE_PINS_REPO || join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const PINS = JSON.parse(read('scripts/engine/pins.json'));
const PIN_FILE = JSON.parse(read(PINS.pin));
const PIN: string = PIN_FILE.version;

/**
 * Every file that runs the engine from its container image, or tells someone to -- web/lib/engineSetup.ts too, the
 * "somewhere else" step of Admin → Extensions' setup screen, which offers a docker run to copy (#72).
 */
const IMAGE_FILES: string[] = PINS.images;

test('the shared pin list names files that exist, and every compose file that runs the engine', () => {
  // Reintroduce by dropping a compose file from scripts/engine/pins.json: this test stops checking it and bump.mjs stops
  // moving it, so that setup alone would run the old engine on data a newer one already migrated.
  for (const f of [PINS.pin, PINS.tested, PINS.fake, ...IMAGE_FILES]) assert.ok(existsSync(join(REPO, f)), `${f} is gone`);
  for (const f of ['deploy/docker-compose.yml', 'deploy/docker-compose.external-db.yml', 'deploy/docker-compose.split.yml', 'docker-compose.yml']) {
    assert.ok(IMAGE_FILES.includes(f), `${f} runs the engine and is not in scripts/engine/pins.json`);
  }
});

test('the pin is a Suwayomi release tag', () => {
  assert.match(PIN, /^v\d+\.\d+\.\d+$/, `scripts/engine/pin.json names "${PIN}", which is not a Suwayomi-Server release tag`);
});

/**
 * Reintroduce by bumping one compose file's tag to v2.3.9999: the assertion names the file whose engine would
 * migrate the shared data ahead of the others.
 */
test('every engine image is the pinned version', () => {
  for (const file of IMAGE_FILES) {
    const tags = [...read(file).matchAll(/ghcr\.io\/suwayomi\/suwayomi-server:([^\s"'<]+)/g)].map((m) => m[1]);
    assert.ok(tags.length > 0, `${file} no longer names the engine image; if it moved, update this list`);
    for (const tag of tags) {
      assert.equal(tag, PIN, `${file} runs suwayomi-server:${tag}, but the pin is ${PIN}: that engine would migrate the shared data ahead of (or behind) every other setup`);
    }
  }
});

test("the fake engine's schema is the pinned engine's", () => {
  // The strict fake (test/fixtures/fakeSuwayomiEngine.mjs) refuses whatever this schema lacks. Captured from an
  // older or newer engine, it would pass queries the pinned one refuses. Re-capture with captureSuwayomiSchema.mjs.
  const file = read('bff/test/fixtures/fakeSuwayomiEngine.mjs').match(/new URL\('\.\/(suwayomi-[^']+-schema\.json)'/)?.[1];
  assert.ok(file, 'the fake engine no longer names its schema file');
  const schema = JSON.parse(read(`bff/test/fixtures/${file}`));
  assert.equal(schema.engine.version, PIN, `the fake engine validates against ${schema.engine.version}'s schema, but the pin is ${PIN}`);
});

test("the server's TESTED_ENGINE is the pin", () => {
  // Health compares a running engine's version with it (enginePin.ts engineStanding). Left behind at a bump, every
  // install would be told its newly pinned engine is "newer than the version this hbook was tested with".
  // Reintroduce by bumping the pin without enginePin.ts: this names both.
  const tested = read(PINS.tested).match(/export const TESTED_ENGINE = '([^']+)'/)?.[1];
  assert.equal(tested, PIN, `${PINS.tested} says TESTED_ENGINE = ${tested}, but the pin is ${PIN}`);
  const oldest = read(PINS.tested).match(/export const OLDEST_ENGINE = '([^']+)'/)?.[1];
  assert.ok(oldest, 'OLDEST_ENGINE went missing');
});
