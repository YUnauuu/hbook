// The release pipeline and the one-click manifests, held to the shape that stops them breaking.
//
// The pipeline broke four of five releases before v0.19.0, every time the same way: arm64 built under QEMU
// on an amd64 runner, and the native-module builds either hung until the timeout or died with SIGILL. The
// fix is structural -- each architecture on a runner of that architecture, merged into one index -- and
// structural fixes are exactly the kind that get undone by a helpful edit ("let's simplify this back to one
// job"). So the structure is pinned here, as text, the way aioParity.test.ts pins the Dockerfiles.
//
// The manifests are pinned for the same reason: an Unraid template with a missing path or an Umbrel compose
// without the proxy block installs fine and then does not work, and nobody here runs Unraid or umbrelOS to
// notice. What can be checked without them is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { parse as parseYaml } from 'yaml';

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
// A value matched literally inside a RegExp: every special character escaped, the backslash too. Escaping only the
// dots is what CodeQL flags as an incomplete escape (js/incomplete-sanitization).
const reLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('arm64 is built on an arm64 runner, never emulated, and merged into one index', () => {
  const y = read('.github/workflows/release.yml');
  const wf = parseYaml(y);
  // Reintroduce by adding setup-qemu-action back: the next release hangs at exactly the timeout again.
  assert.ok(!/setup-qemu/.test(code(y)), 'release.yml uses QEMU emulation again');
  assert.match(code(y), /ubuntu-24\.04-arm/, 'no native arm64 runner');
  assert.match(code(y), /push-by-digest=true/, 'architectures are not pushed by digest, so the tag can point at one of them');
  assert.ok(wf.jobs.merge, 'no merge job: nothing writes the tag over both architectures');
  assert.match(code(y), /imagetools create -t "\$\{\{ matrix\.image \}\}:\$\{\{ matrix\.tag_prefix \}\}\$\{\{ github\.ref_name \}\}"/, 'the merge job does not write the version tag');
  assert.match(code(y), /grep -q "linux\/\$arch"/, 'the merge job does not check both architectures are in the index');
  // Reintroduce by piping `imagetools inspect` into grep -q or an early-exiting awk: buildx dies of SIGPIPE,
  // pipefail makes that the step's status, and every merge fails after every build succeeded -- the first
  // run of this pipeline, exactly.
  assert.ok(!/imagetools inspect[^\n]*\|\s*(grep|awk|head)/.test(code(y)), 'release.yml pipes an imagetools inspect into a reader that can close the pipe early');
  // The gate: latest moves only after every image is merged. Reintroduce by pointing `needs` at build.
  assert.equal(wf.jobs.latest.needs, 'merge', 'latest is not gated on the merged indexes');
  assert.equal(wf.jobs.merge.needs, 'build');
  for (const j of ['build', 'merge', 'latest']) assert.ok(wf.jobs[j]['timeout-minutes'], `${j} has no timeout`);
  assert.match(y, /attest-build-provenance/, 'no provenance attestation');
  assert.equal(wf.permissions['id-token'], 'write', 'attestations need id-token: write');
  assert.equal(wf.permissions.attestations, 'write');
  // The digest the merge job trusts is checked before it is written. `build-push-action` sets that output
  // only `if (digest)`, so a build that produced no image metadata leaves it empty -- and an empty digest
  // reaches `imagetools create` as a bare `image@`, which is how a tag ends up over one architecture or
  // none. Reintroduce by dropping the `sha256:` case: the guard is the only thing between an empty output
  // and a half-published tag, and `merge` runs `fail-fast: false`, so nothing else would stop it.
  const record = wf.jobs.build.steps.find((st: any) => st.name === 'Record the digest');
  assert.ok(record, 'no step records the per-arch digest');
  assert.match(record.run, /sha256:\*\)/, 'the recorded digest is not validated before it is written');
  assert.match(record.run, /exit 1/, 'a malformed digest does not fail the build');
  // Every image, both architectures.
  assert.deepEqual(wf.jobs.build.strategy.matrix.service, ['bff', 'web', 'aio', 'title-extractor']);
  assert.deepEqual(wf.jobs.build.strategy.matrix.arch, ['amd64', 'arm64']);
});

test('optional title inference ships on both native architectures without model weights or application secrets', () => {
  const release = parseYaml(read('.github/workflows/release.yml'));
  const worker = release.jobs.build.strategy.matrix.include.find((item: any) => item.service === 'title-extractor');
  assert.equal(worker.image, 'ghcr.io/yunauuu/hbook');
  assert.match(worker.license, /Apache-2\.0/);
  const mergeRows = release.jobs.merge.strategy.matrix.include;
  assert.equal(mergeRows.find((item: any) => item.service === 'title-extractor').tag_prefix, 'title-extractor-');
  const targets = release.env.IMAGE_TAG_PREFIXES.split(' ').map((entry: string) => entry.split('='));
  assert.deepEqual(targets, mergeRows.map((row: any) => [row.image, row.tag_prefix ?? '']), 'every versioned image must join the coherent latest gate');
  assert.equal(new Set(targets.map((pair: string[]) => pair.join(':') + 'latest')).size, 4, 'the worker must never overwrite the app latest/version tags');
  const promotion = release.jobs.latest.steps.find((step: any) => step.name.startsWith('Point latest')).run;
  assert.match(promotion, /-t "\$img:\$\{prefix\}latest" "\$img:\$\{prefix\}\$\{GITHUB_REF_NAME\}"/);
  const checkout = release.jobs.build.steps.find((step: any) => step.with?.repository === 'ymy-k/Hi-SAM');
  assert.equal(checkout.with.ref, '69009434d4dba5541f228d8f5acb0754c333d417');
  assert.equal(checkout.with['persist-credentials'], false);
  const ci = parseYaml(read('.github/workflows/ci.yml')).jobs['title-extractor'];
  assert.deepEqual(ci.strategy.matrix.include.map((item: any) => item.arch), ['amd64', 'arm64']);
  assert.match(JSON.stringify(ci.steps), /test_\*\.py/);
  assert.match(JSON.stringify(ci.steps), /--prepare-context/);
  const overlay = parseYaml(read('deploy/docker-compose.title-extractor.yml'));
  const service = overlay.services['title-extractor'];
  assert.equal(service.image, '${TITLE_EXTRACTOR_IMAGE:-ghcr.io/yunauuu/hbook:title-extractor-v' + JSON.parse(read('bff/package.json')).version + '}');
  assert.deepEqual(service.profiles, ['title-art']);
  assert.equal(service.read_only, true);
  assert.equal(service.ports, undefined);
  assert.deepEqual(service.networks, ['title_extractor']);
  assert.equal(overlay.networks.title_extractor.internal, true);
  assert.equal(service.mem_limit, '4g');
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.equal(service.env_file, '.env.title-extractor');
  assert.equal(overlay.services.hbook.image, undefined, 'the overlay must not replace an existing pinned app image');
  assert.ok(service.volumes.every((mount: string) => mount.endsWith(':/models:ro')));
  assert.ok(!JSON.stringify(service).includes('/config') && !JSON.stringify(service).includes('/library'));
  assert.match(read('.gitignore'), /^\.env\.title-extractor$/m);
});

test('latest promotion keeps optional worker tags separate from the public application tags', async () => {
  const release = parseYaml(read('.github/workflows/release.yml'));
  const directory = mkdtempSync(join(tmpdir(), 'title-release-'));
  const log = join(directory, 'calls.jsonl');
  // Exercise the actual shell with a local fake registry command; this never contacts a registry.
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.TITLE_RELEASE_CALLS,JSON.stringify(args)+'\\n');if(args[2]==='inspect')console.log('Digest: sha256:${'a'.repeat(64)}');\n`, { mode: 0o755 });
  try {
    for (const step of release.jobs.latest.steps.filter((item: any) => item.run)) {
      await new Promise<void>((resolve, reject) => execFile('bash', ['-c', step.run], {
        cwd: directory, timeout: 10_000,
        env: { ...process.env, PATH: directory + ':' + process.env.PATH, TITLE_RELEASE_CALLS: log,
          IMAGE_TAG_PREFIXES: release.env.IMAGE_TAG_PREFIXES, GITHUB_REF_NAME: 'v0.102.0' },
      }, (error) => error ? reject(error) : resolve()));
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const creates = calls.filter((args) => args[2] === 'create');
    assert.deepEqual(creates.map((args) => args.slice(4)), [
      ['ghcr.io/yunauuu/hbook-bff:latest', 'ghcr.io/yunauuu/hbook-bff:v0.102.0'],
      ['ghcr.io/yunauuu/hbook-web:latest', 'ghcr.io/yunauuu/hbook-web:v0.102.0'],
      ['ghcr.io/yunauuu/hbook:latest', 'ghcr.io/yunauuu/hbook:v0.102.0'],
      ['ghcr.io/yunauuu/hbook:title-extractor-latest', 'ghcr.io/yunauuu/hbook:title-extractor-v0.102.0'],
    ]);
    assert.equal(calls.filter((args) => args[2] === 'inspect').length, 8, 'verify both tags for all four images');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a tag publishes a GitHub Release, not just images', () => {
  const y = read('.github/workflows/release.yml');
  const wf = parseYaml(y);
  // ⚠️ This was manual for the whole life of the project, and three releases in a row were missed --
  // v0.22.0, v0.23.0 and v0.24.0 all shipped, published and deployed while the Releases page still said
  // v0.21.0. Not cosmetic: the README's "latest release" badge reads Releases rather than tags, so the
  // front page advertised a version three behind, and docs/INSTALL.md tells people to watch Releases to
  // know when there is something to pull.
  assert.ok(wf.jobs.release, 'nothing publishes a GitHub Release, so tags will silently stop announcing');
  // After the images exist. A release announcing a publish that failed is worse than no release.
  assert.equal(wf.jobs.release.needs, 'merge');
  // NOT gated on `latest`: a prerelease tag should still get an entry, marked as one.
  assert.ok(!wf.jobs.release.if, 'the release job must run for prerelease tags too');
  assert.match(code(y), /--prerelease/, 'an rc tag would be published as a normal release');
  // The notes come from the changelog, so a release cannot describe something other than the file
  // everyone reads. Reintroduce by switching to --generate-notes unconditionally.
  assert.match(code(y), /CHANGELOG\.md/, 'the release notes do not come from the changelog');
  // Write access is scoped to this one job rather than widened at the top of the file.
  assert.equal(wf.jobs.release.permissions?.contents, 'write');
  assert.equal(wf.permissions.contents, 'read', 'the workflow as a whole must not gain write access');
});

test('dependencies and actions are watched weekly, grouped so CI is not run thirty times', () => {
  const d = parseYaml(read('.github/dependabot.yml'));
  const npm = d.updates.filter((u: any) => u['package-ecosystem'] === 'npm').map((u: any) => u.directory).sort();
  assert.deepEqual(npm, ['/bff', '/web']);
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'npm')) {
    assert.ok(u.groups && Object.keys(u.groups).length, `${u.directory}: npm updates are not grouped`);
    assert.equal(u.schedule.interval, 'weekly');
  }
  assert.ok(d.updates.some((u: any) => u['package-ecosystem'] === 'github-actions'), 'actions are not watched');
  const docker = d.updates.filter((u: any) => u['package-ecosystem'] === 'docker').map((u: any) => u.directory).sort();
  assert.deepEqual(docker, ['/', '/bff', '/services/title-extractor', '/web'], 'not every Dockerfile has its base image watched');
  // A Node major is taken deliberately, onto an even LTS line: never a weekly PR for an odd, short-lived release
  // (#73-#75 proposed node:25 after its end of life), and never @types/node ahead of the runtime (#62, #77).
  // Reintroduce by deleting either ignore rule from any one entry: the assertion names the directory.
  const ignores = (u: any, dep: string) =>
    (u.ignore ?? []).some((i: any) => i['dependency-name'] === dep && (i['update-types'] ?? []).includes('version-update:semver-major'));
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'docker')) {
    const runtime = u.directory === '/services/title-extractor' ? 'python' : 'node';
    assert.ok(ignores(u, runtime), `docker ${u.directory}: ${runtime} majors arrive as weekly PRs`);
  }
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'npm'))
    assert.ok(ignores(u, '@types/node'), `npm ${u.directory}: @types/node can run ahead of the Node runtime`);
  const cq = parseYaml(read('.github/workflows/codeql.yml'));
  assert.match(JSON.stringify(cq), /javascript-typescript/);
  assert.equal(cq.permissions['security-events'], 'write');
});

test('every CI job has a timeout, and installs from the lockfile', () => {
  const y = read('.github/workflows/ci.yml');
  const ci = parseYaml(y);
  // release.yml had a timeout on every job since v0.19.0 and ci.yml had one only on e2e, so a hung
  // integration test sat for GitHub's 360-minute default with the whole queue behind it. Reintroduce by
  // removing timeout-minutes from the test job: this names it.
  for (const j of Object.keys(ci.jobs)) assert.ok(ci.jobs[j]['timeout-minutes'], `ci.yml job "${j}" has no timeout`);
  // And not a timeout the job cannot meet: Tests took 54-58 minutes on every green run 2026-09-25..26, and
  // v0.48.4's first run was cancelled at a 60-minute limit with all 1988 tests passed.
  assert.ok(ci.jobs.test['timeout-minutes'] >= 80, 'the test job timeout is below what a green run needs');
  assert.ok(ci.jobs.e2e['timeout-minutes'] >= 80, 'the browser timeout cannot hold the baseline, embedded and feature walks');
  // What keeps a green run inside that limit since v0.49.0: the bff files run a few at a time, each on a fresh
  // database of its own (test/run-shards.mjs), not one after another on one database. Reintroduce by putting
  // `npm test` back in the BFF step: this names it.
  const bffStep = (ci.jobs.test.steps ?? []).find((st: any) => st.name === 'BFF tests');
  assert.ok(bffStep, 'the BFF tests step went missing');
  assert.match(String(bffStep.run), /\bnpm run test:ci\b/, 'CI runs the bff files one at a time on one database again');
  const pkg = JSON.parse(read('bff/package.json'));
  assert.equal(pkg.scripts['test:ci'], 'node test/run-shards.mjs', 'test:ci no longer runs the files on databases of their own');
  // `npm install` may resolve differently from package-lock.json and rewrites it on the runner, so a
  // Dependabot lockfile bump was never what CI tested; `npm ci` refuses a lockfile that disagrees.
  // Reintroduce by changing one `npm ci` back to `npm install`: this names the step.
  const steps = Object.values(ci.jobs).flatMap((j: any) => (j.steps ?? []).map((st: any) => ({ job: j.name, name: st.name, run: String(st.run ?? '') })));
  const installs = steps.filter((st) => /\bnpm (install|ci)\b/.test(st.run));
  assert.ok(installs.length >= 3, 'the install steps went missing');
  for (const st of installs) assert.ok(!/\bnpm install\b/.test(st.run), `${st.job} / ${st.name} uses npm install instead of npm ci`);

  // Build once, then resolve that tag to an immutable image id in up.sh for every stack. Building inside a later
  // phase made a green feature walk evidence for different bytes than the baseline (and than another phase).
  const e2e = ci.jobs.e2e.steps ?? [];
  const image = e2e.find((st: any) => st.name === 'Build the exact browser AIO image once');
  assert.match(String(image?.run), /docker build -f Dockerfile\.aio -t hbook:e2e-ci \./,
    'the browser job does not build its one AIO image explicitly');
  for (const name of ['Bring it up and drive it', 'Bring it up again with the embedded database, and drive it']) {
    const run = String(e2e.find((st: any) => st.name === name)?.run ?? '');
    assert.match(run, /E2E_SKIP_BUILD=1/, `${name} silently rebuilds the image`);
    assert.match(run, /E2E_IMAGE=hbook:e2e-ci/, `${name} does not use the exact browser image`);
  }
  assert.match(String(e2e.find((st: any) => st.name === 'Drive every v0.55.8 feature phase on that image')?.run),
    /E2E_IMAGE=hbook:e2e-ci bash test\/e2e\/run-v558\.sh/,
    'the required Browser end-to-end check omits the v0.55.8 feature walk');
  const feature = read('web/test/e2e/run-v558.sh');
  for (const phase of ['librarysort', 'homelists', 'anilistprivacy', 'bulkdelete'])
    assert.match(feature, new RegExp(`run_phase ${phase}\\s`), `the browser gate omits ${phase}`);
  assert.match(feature, /E2E_SKIP_BUILD=1 E2E_IMAGE="\$IMAGE"/, 'a feature phase may rebuild or retag the tested image');
  const up = read('web/test/e2e/up.sh');
  assert.match(up, /LIB="\$LIB" E2E_NET="\$NET" node "\$WALK_SCRIPT"/,
    'the selected feature walk cannot use its disposable filesystem/database, or loses its exit code');
});

/**
 * What Unraid's dockerMan needs to read a template at all, shared by both templates.
 *
 * Walked with indexOf rather than a `<!--([\s\S]*?)-->` regex: this is XML, where `--!>` is not a terminator and
 * `--` in the body is the actual fault, but CodeQL's js/bad-tag-filter (#28) reads any comment regex as an HTML
 * sanitiser and re-fires on every edit of the line. A plain scan says the same thing without giving the rule a
 * regex to misjudge, and a comment that never closes fails here by name instead of as a mismatch of two counts.
 */
function assertParsableTemplate(x: string, file: string): void {
  for (let at = 0; ; ) {
    const s = x.indexOf('<!--', at);
    if (s < 0) break;
    const e = x.indexOf('-->', s + 4);
    assert.ok(e >= 0, `${file}: an XML comment that never closes: ${x.slice(s, s + 60).trim()}…`);
    const body = x.slice(s + 4, e);
    assert.ok(!body.includes('--'), `${file}: "--" inside an XML comment, which no parser accepts: ${body.trim().slice(0, 60)}…`);
    at = e + 3;
  }
  // The same parser would also refuse a `-` glued to the closing `-->`.
  assert.ok(!/--->/.test(x), `${file}: a comment ending in "--->" is malformed`);
  // Both files CA moderators read must start with the XML declaration and carry one root element each.
  assert.match(x, /^<\?xml version="1\.0"\?>\n/, `${file}: the template lacks the XML declaration`);
  // Well-formed enough: every <Config ...> is closed on its own line.
  const opens = (x.match(/<Config /g) || []).length, closes = (x.match(/<\/Config>/g) || []).length;
  assert.equal(opens, closes, `${file}: an unclosed <Config> element`);
}

test('the Unraid template names every volume, the ports, and the ids, and stops gracefully', () => {
  const x = read('templates/hbook.xml');
  assert.match(x, /<Repository>ghcr\.io\/yunauuu\/hbook<\/Repository>/);
  assert.match(x, /<WebUI>http:\/\/\[IP\]:\[PORT:3000\]\/<\/WebUI>/, 'the WebUI link does not map the container port');
  for (const target of ['/library', '/data', '/config', '/library-dl', '/cache', '/backups']) {
    assert.match(x, new RegExp(`Target="${target}"[^>]*Type="Path"`), `no Path config for ${target}`);
  }
  for (const v of ['PUID', 'PGID', 'PUBLIC_ORIGIN']) assert.match(x, new RegExp(`Target="${v}"[^>]*Type="Variable"`), `no ${v} variable`);
  assert.match(x, /Target="3000"[^>]*Type="Port"/, 'no port mapping for 3000');
  // Reintroduce by deleting ExtraParams: Unraid stops the container with Docker's 10 s default and Postgres
  // is killed mid-checkpoint on every "Update" and every array stop.
  assert.match(x, /--stop-timeout 40/, 'no stop timeout for the embedded database');
  // A Config element, not a mention: the template's own comment explains that DATABASE_URL is unset.
  assert.ok(!/Target="DATABASE_URL"/.test(x), 'the template sets DATABASE_URL, which turns the embedded database off');
  // ⚠️ `--` inside an XML comment is illegal (XML 1.0 §2.5), and Unraid's dockerMan parses the template with
  // a real parser. The v0.21.0 rewrite of the header comment -- the one that fixed the install steps after
  // hawwwwwk's first report -- wrote "never read -- so", and from then until v0.34.0 the file could not be
  // installed by anyone: the parse fails at the comment, before the first <Config>. Every check above passed
  // the whole time, because none of them parsed. hawwwwwk found that too (PR #50). There is no XML parser
  // among the dependencies, so the comment bodies are checked by hand, the way a parser would refuse them.
  // Reintroduce by writing `--` back into the header comment: this names the offending comment.
  assertParsableTemplate(x, 'templates/hbook.xml');
  const ca = read('ca_profile.xml');
  assert.match(ca, /^<\?xml version="1\.0"\?>\n<CommunityApplications>[\s\S]*<\/CommunityApplications>\s*$/, 'ca_profile.xml is not a CommunityApplications document');
  // The icon must be the app's own icon, the same file the template shows; the CA listing reads ca_profile.
  assert.match(ca, /<Icon>https:\/\/raw\.githubusercontent\.com\/YUnauuu\/hbook\/main\/web\/public\/icons\/icon-512\.png<\/Icon>/, 'the CA profile icon is not the app icon');
  assert.ok(existsSync(join(REPO, 'web/public/icons/icon-512.png')), 'the icon both files point at is not in the repo');
  // The main repo is the CA template repository now; a TemplateURL at the old unraid-templates repo would
  // have Unraid refresh the template from a file that is only kept for old links.
  assert.match(x, /<TemplateURL>https:\/\/raw\.githubusercontent\.com\/YUnauuu\/hbook\/main\/templates\/hbook\.xml<\/TemplateURL>/, 'TemplateURL does not point at this repo');
});

/** One <Config> element of a template, by Target: its attributes and its value. */
function configOf(x: string, target: string): { attrs: string; value: string } | null {
  const m = x.match(new RegExp(`<Config ([^>]*Target="${target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*)>([^<]*)</Config>`));
  return m ? { attrs: m[1], value: m[2] } : null;
}

/**
 * #72: the extension engine for Unraid, as a template of its own, set up the way the compose files set it up.
 * Before it, an Unraid user had to find, pin and configure a Suwayomi container by hand, and the one shipped
 * uncapped in every layout until v0.46.0 took a quarter of the host's memory (discussion #72).
 *
 * Reintroduce by deleting `--memory=2048m` from ExtraParams: the uncapped JVM is back on Unraid. Or write `--`
 * into its header comment: dockerMan cannot parse the file (PR #50), and the helper above names it.
 *
 * #275: Unraid has no swap by default, so the ceiling is a hard wall there, and 1536m killed engines that needed
 * 1.4 GB (630 MB of it heap). Reintroduce by putting `1536m` back, raising -Xmx alone, or deleting MALLOC_ARENA_MAX.
 */
test('the Unraid engine template is the bundled engine', () => {
  const file = 'templates/hbook-suwayomi.xml';
  const x = read(file);
  assertParsableTemplate(x, file);
  assert.match(x, /<Repository>ghcr\.io\/suwayomi\/suwayomi-server:v[\d.]+<\/Repository>/, 'the engine image is not pinned (enginePins.test.ts holds the version)');
  assert.match(x, /<ExtraParams>[^<]*--memory=\d+[mg]\b[^<]*<\/ExtraParams>/, 'no memory ceiling: a JVM sizes its heap from the whole server');
  assert.match(configOf(x, 'JAVA_TOOL_OPTIONS')?.value ?? '', /-Xmx\d+[mMgG]/, "the engine's heap is not capped");
  const ceiling = x.match(/<ExtraParams>[^<]*--memory=(\d+)([mg])\b/);
  const heap = (configOf(x, 'JAVA_TOOL_OPTIONS')?.value ?? '').match(/-Xmx(\d+)([mMgG])/);
  const mib = (n: string, unit: string) => Number(n) * (/^[gG]$/.test(unit) ? 1024 : 1);
  assert.ok(ceiling && heap && mib(ceiling[1], ceiling[2]) - mib(heap[1], heap[2]) >= 1280,
    "the ceiling leaves less than 1.25 GB above the heap: with no swap the kernel kills the engine there (#275)");
  const arenas = configOf(x, 'MALLOC_ARENA_MAX');
  assert.equal(arenas?.value, '2', 'glibc may keep freed memory in up to eight arenas per CPU (#275)');
  assert.match(arenas!.attrs, /Default="2"/, "MALLOC_ARENA_MAX's default is not 2");
  const data = configOf(x, '/home/suwayomi/.local/share/Tachidesk');
  assert.ok(data && /Type="Path"/.test(data.attrs), "no Path for the engine's data: every install would lose its extensions and series links on update");
  assert.match(data!.value, /^\/mnt\/user\/appdata\/hbook-suwayomi$/, 'the engine data is not in its own appdata folder');
  assert.ok(/Type="Port"/.test(configOf(x, '4567')?.attrs ?? ''), 'no port 4567 for hbook to reach');
  for (const [k, v] of [['AUTO_DOWNLOAD_CHAPTERS', 'false'], ['DOWNLOAD_AS_CBZ', 'true'], ['WEB_UI_ENABLED', 'false'], ['FLARESOLVERR_ENABLED', 'true']] as const) {
    const c = configOf(x, k);
    assert.equal(c?.value, v, `${k} is not ${v} on the Unraid engine`);
    assert.match(c!.attrs, new RegExp(`Default="${v}"`), `${k}'s default is not ${v}`);
  }
  assert.ok(configOf(x, 'FLARESOLVERR_URL'), 'no FLARESOLVERR_URL to point the engine at a solver');
  assert.match(configOf(x, 'AUTH_PASSWORD')?.attrs ?? '', /Mask="true"/, "the engine's password is shown in clear");
  // v0.73.0: the port is published on the bridge network, so a new install signs in. Reintroduce the empty AUTH_MODE
  // (or a password Unraid lets you leave blank): a new engine starts with no password, and these fail.
  // An install from before keeps its own values: the three variables have been here since the template's first version.
  const auth = configOf(x, 'AUTH_MODE');
  assert.equal(auth?.value, 'basic_auth', 'a new Unraid engine starts with its sign-in off');
  assert.match(auth!.attrs, /Default="basic_auth"/, "AUTH_MODE's default is not basic_auth");
  assert.match(configOf(x, 'AUTH_PASSWORD')!.attrs, /Required="true"/, 'the engine can be installed without a password');
  assert.equal(configOf(x, 'AUTH_PASSWORD')!.value, '', 'the template ships a password everyone knows');
  assert.match(x, /<TemplateURL>https:\/\/raw\.githubusercontent\.com\/YUnauuu\/hbook\/main\/templates\/hbook-suwayomi\.xml<\/TemplateURL>/, 'TemplateURL does not point at this file');
  // The way in: the main template's help names the engine template, and it can pass the engine's credentials.
  const main = read('templates/hbook.xml');
  assert.match(configOf(main, 'SUWAYOMI_URL')?.attrs ?? '', /Description="[^"]*hbook-suwayomi[^"]*:4567/, "the main template's SUWAYOMI_URL help does not point at the engine template");
  assert.ok(configOf(main, 'SUWAYOMI_USERNAME'), 'the main template cannot pass the engine user name');
  // The two user names match out of the box, so a new install types the password twice and nothing else.
  assert.equal(configOf(main, 'SUWAYOMI_USERNAME')!.value, configOf(x, 'AUTH_USERNAME')?.value, 'the two templates name different engine users');
  assert.ok(configOf(x, 'AUTH_USERNAME')?.value, 'the engine has no user name');
  assert.match(configOf(main, 'SUWAYOMI_PASSWORD')?.attrs ?? '', /Mask="true"/, "the main template shows the engine's password in clear");
});

test('the Umbrel package is the one under review: proxy block, PUID, digest pin, data under app-data', () => {
  // Mirrors what was submitted to getumbrel/umbrel-apps and linted there with `lint:apps --check-images`.
  const m = parseYaml(read('deploy/umbrel/hbook/umbrel-app.yml'));
  assert.equal(m.manifestVersion, 1); assert.equal(m.id, 'hbook');
  // 8110: unique across the store's manifest ports and raw compose ports at submission time (8080 was not).
  assert.equal(m.port, 8110);
  for (const k of ['name', 'tagline', 'description', 'developer', 'repo', 'support', 'category', 'version', 'submitter']) assert.ok(m[k], `manifest lacks ${k}`);
  assert.deepEqual(m.gallery, [], 'the store adds gallery images; the package ships none');
  assert.deepEqual(m.permissions, ['STORAGE_DOWNLOADS'], 'the library is read from Umbrel Downloads, which needs this permission');
  assert.match(m.submission, /getumbrel\/umbrel-apps\/pull\/\d+$/, 'submission must be the store PR');
  const c = parseYaml(read('deploy/umbrel/hbook/docker-compose.yml'));
  assert.ok(c.services.app_proxy, 'no app_proxy service: Umbrel cannot route to the app');
  assert.equal(c.services.app_proxy.environment.APP_HOST, 'hbook_server_1');
  assert.equal(c.services.app_proxy.environment.APP_PORT, 3000);
  // OPDS readers and API-token scripts cannot carry the Umbrel cookie; first-run setup must stay behind it.
  assert.match(String(c.services.app_proxy.environment.PROXY_AUTH_WHITELIST), /\/opds\/\*.*\/img\/\*.*\/api\/\*/);
  assert.match(String(c.services.app_proxy.environment.PROXY_AUTH_BLACKLIST), /\/api\/setup/, 'first-run setup is reachable without Umbrel login');
  // The Mihon/Tachiyomi extension (AngeloSha/hbook-extension, probeServer/probeToken) tests a server address on
  // GET /healthz and a token on GET /auth/me before it browses /api and /img. Behind the Umbrel login both answer
  // with Umbrel's sign-in page, and the extension reports "No hbook at ..." for a server that works. Exact paths:
  // the rest of /auth (sign-in, registration) stays behind Umbrel, like first-run setup.
  const whitelisted = String(c.services.app_proxy.environment.PROXY_AUTH_WHITELIST).split(',');
  for (const p of ['/healthz', '/auth/me']) assert.ok(whitelisted.includes(p), `${p} is behind the Umbrel login: the Mihon extension's connection check fails there`);
  assert.deepEqual(whitelisted.filter((p) => p.startsWith('/auth')), ['/auth/me'], 'more of /auth than /auth/me is outside the Umbrel login');
  const s = c.services.server;
  // PUID/PGID, not user:: the image has a permission-fixing root entrypoint (the store guide's own rule).
  assert.equal(s.user, undefined, 'user: forces a uid on an image whose entrypoint must start as root');
  assert.equal(String(s.environment.PUID), '1000'); assert.equal(String(s.environment.PGID), '1000');
  assert.match(s.image, /^ghcr\.io\/yunauuu\/hbook:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, 'Umbrel requires the image pinned by digest');
  assert.ok(!/0{64}/.test(s.image), 'the digest is still the placeholder');
  assert.ok(!('DATABASE_URL' in (s.environment ?? {})), 'DATABASE_URL set: the embedded database is off and there is no other');
  assert.ok(s.volumes.some((v: string) => v.startsWith('${APP_DATA_DIR}/data/db:') && v.endsWith(':/data')), 'the database must live under app-data');
  assert.ok(s.volumes.some((v: string) => v.includes('/data/storage/downloads/') && v.endsWith(':/library')), 'the library must come from Umbrel Downloads');
  // umbrelOS 2.0 (2026-09-22). `storage` lets a user move the app's data to an external drive (ext4 only), and a
  // version without it cannot start an install whose data was moved -- so once declared it is never removed. It moves
  // `${APP_DATA_DIR}/data` and nothing else, which is why every app-data mount must come from under data/.
  assert.deepEqual(m.storage, { dataRoot: 'data' }, 'storage was removed: installs whose data was moved cannot start');
  for (const v of s.volumes.filter((v: string) => v.startsWith('${APP_DATA_DIR}'))) assert.match(v, /^\$\{APP_DATA_DIR\}\/data\/[a-z]+:/, `${v} is outside data/, which umbrelOS moves with the app`);
  // The library's folder setting. umbrelOS makes one from the Downloads mount on its own, with the id
  // `umbrel-downloads:<folder>` (umbreld apps/app.ts); this entry gives it a name and a note. A different id, service
  // or target would be a second, empty setting, and changing the id later drops every user's chosen folder.
  const lib = (m.folderAccess ?? []).find((x: any) => x.id === 'umbrel-downloads:manga');
  assert.ok(lib && lib.name && lib.note, 'the library has no named folder setting (folderAccess umbrel-downloads:manga)');
  assert.deepEqual(lib.mounts, [{ service: 'server', targetPath: '/library' }]);
  assert.ok(s.volumes.includes('${UMBREL_ROOT}/data/storage/downloads/manga:/library'), 'the folder setting no longer names the compose mount');
  assert.match(String(s.stop_grace_period), /40s/);
  assert.ok(s.image.includes(`:v${m.version}@`), `manifest version ${m.version} does not match the pinned image ${s.image}`);
  assert.match(String(s.environment.JWT_SECRET), /APP_HBOOK_JWT_SECRET/, 'the session secret should come from exports.sh');
  // v0.49.0 (#72): Admin → Extensions opens its engine setup steps on the platform this hint names (bff
  // lib/platform.ts), and Umbrel's say that an Umbrel app cannot add the optional engine. Nothing else gives an
  // Umbrel install away -- no HOST_OS, no EXTENSION_ENGINE -- so without the line it reads as 'unknown' and opens on
  // steps it cannot follow. Reintroduce by deleting the line from the compose file: this assertion names it.
  assert.equal(s.environment.HBOOK_PLATFORM, 'umbrel', 'the Umbrel compose does not tell the app it runs on Umbrel (HBOOK_PLATFORM: umbrel)');
  assert.match(read('deploy/umbrel/hbook/exports.sh'), /derive_entropy/, 'exports.sh does not derive the secret');
  for (const d of ['db', 'config', 'cache', 'downloads', 'backups']) assert.ok(existsSync(join(REPO, `deploy/umbrel/hbook/data/${d}/.gitkeep`)), `data/${d} is not committed; Umbrel would mount an empty root-owned path`);
  const f = c.services.flaresolverr ?? c.services.trawl;
  assert.match(f?.image ?? '', /^ghcr\.io\/(flaresolverr\/flaresolverr:v|germondai\/trawl:)\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, 'the solver sidecar is not pinned by release tag and digest');
});

test('the Umbrel package is never more than one release behind', () => {
  // deploy/umbrel pins the image by digest, and a digest exists only once a tag's release run has published it, so
  // the release PR itself can never carry its own version here. Nothing asked for the follow-up either, and from
  // v0.40.0 to v0.61.2 nobody did it, while docs/INSTALL.md told Umbrel users this package was current. The rule:
  // it pins the version in package.json or the release before it. A release PR goes red until the package pins the
  // release that is already out; the merge job of release.yml prints that digest, and so does
  //   docker buildx imagetools inspect ghcr.io/yunauuu/hbook:v<version>
  // Reintroduce by leaving the pin behind at a release: this test fails on that release's PR.
  const now = JSON.parse(read('bff/package.json')).version as string;
  const released = [...read('CHANGELOG.md').matchAll(/^## v(\d+\.\d+\.\d+) /gm)].map((x) => x[1]);
  const before = released.find((v) => v !== now);
  assert.ok(before, 'CHANGELOG.md names no earlier release');
  const pinned = String(parseYaml(read('deploy/umbrel/hbook/umbrel-app.yml')).version);
  assert.ok([now, before].includes(pinned),
    `deploy/umbrel pins v${pinned}, more than one release behind v${now}: pin v${now} if its images are published, else v${before} -- the version in umbrel-app.yml, the image tag and digest in docker-compose.yml`);
});

test('an Unraid or Umbrel user can still get from the README to their manifest', () => {
  // The property is that the path exists, not that it is one hop. The per-platform install moved out of the
  // README in v0.24.0 -- it was longer on its own than five comparable projects' entire READMEs -- so this
  // follows it, and additionally pins the link that makes it reachable. Reintroduce by dropping either the
  // README's pointer to the install guide or one of the manifest links inside it: a NAS user lands on a
  // quick start that assumes Docker Compose and never learns their platform has a one-click template.
  const r = read('README.md');
  assert.match(r, /docs\/INSTALL\.md/, 'the README no longer points anywhere for platform installs');
  const i = read('docs/INSTALL.md');
  // `templates/hbook.xml` since PR #50: the layout Community Applications reads from the main repo.
  assert.match(i, /templates\/hbook\.xml/, 'the install guide does not point Unraid users at the template');
  assert.ok(!/deploy\/unraid\//.test(i), 'the install guide still names the pre-#50 template path, which no longer exists');
  assert.ok(existsSync(join(REPO, 'templates/hbook.xml')), 'the Unraid template moved');
  assert.match(i, /deploy\/umbrel\/hbook/, 'the install guide does not point Umbrel users at the manifest');
  assert.ok(existsSync(join(REPO, 'deploy/casaos/docker-compose.yml')), 'the CasaOS manifest moved');
});

test('the Phase 0 spike workflows are gone, and nothing points at the spike folders', () => {
  // They only ran on their spike branches. A workflow file that cannot work is a trap for the next person who
  // pushes one of those branches. Reintroduce by restoring either file: this names it.
  const wfs = readdirSync(join(REPO, '.github/workflows'));
  assert.deepEqual(wfs.filter((f) => /spike/.test(f)), [], 'a spike workflow is still in .github/workflows');
  for (const f of wfs) {
    const y = code(read(`.github/workflows/${f}`));
    assert.ok(!/desktop-engine\/|desktop-spike-solver/.test(y), `${f} still uses a spike folder`);
  }
});

test('the engine canary only reads, unless the owner switches its reporting on -- and then never touches main, a tag or a PR', () => {
  // .github/workflows/engine-canary.yml tests every new Suwayomi-Server every week (the engine upgrade). It runs on a
  // schedule with the repository's token, so its shape is pinned: scheduled and dispatched only (never on a push or a
  // pull request, where a fork's code would run with it), read-only at the top, the write permissions on the report
  // job alone and that job behind the ENGINE_CANARY_POST switch, no secret but GITHUB_TOKEN, a timeout on every job,
  // and the one push it makes is the engine-bump/<tag> branch. Reintroduce `contents: write` at the top, a
  // `secrets.SOMETHING`, `pull_request:` in `on`, a report job without the switch, or a `git push origin HEAD:main` in
  // scripts/engine/report.mjs: each names itself below.
  const y = read('.github/workflows/engine-canary.yml');
  const wf = parseYaml(y);
  assert.deepEqual(Object.keys(wf.on).sort(), ['schedule', 'workflow_dispatch'], 'the canary runs on something other than its schedule and a dispatch');
  assert.equal(wf.on.schedule[0].cron, '23 5 * * 1');
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs).sort(), ['preview', 'version']);
  assert.equal(wf.on.workflow_dispatch.inputs.preview.default, true);
  assert.deepEqual(wf.permissions, { contents: 'read' }, 'the canary has write permissions outside its report job');
  assert.ok(wf.concurrency?.group, 'two canaries could run at once');
  for (const [name, job] of Object.entries<any>(wf.jobs)) {
    assert.ok(job['timeout-minutes'], `engine-canary.yml job "${name}" has no timeout`);
    const writes = Object.entries(job.permissions ?? {}).filter(([, v]) => v === 'write').map(([k]) => k);
    if (name === 'report') assert.deepEqual(writes.sort(), ['contents', 'issues']);
    else assert.deepEqual(writes, [], `job "${name}" may write`);
  }
  assert.match(String(wf.jobs.report.if), /vars\.ENGINE_CANARY_POST == 'on'/, 'the report job posts without the owner\'s switch');
  const secrets = [...code(y).matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)], ['GITHUB_TOKEN'], 'the canary reads a secret other than its own token');
  // The pushes: the workflow makes none itself, and report.mjs makes exactly one, to the bump branch.
  assert.ok(!/git push|gh pr create|refs\/tags/.test(code(y)), 'the workflow pushes or opens a pull request itself');
  const report = read('scripts/engine/report.mjs');
  const pushes = [...report.matchAll(/git\('push'[^\n]*/g)].map((m) => m[0]);
  assert.equal(pushes.length, 1, 'report.mjs pushes in more than one place');
  assert.match(pushes[0], /`HEAD:refs\/heads\/\$\{branch\}`/);
  assert.match(report, /const branch = `engine-bump\/\$\{r\.tag\}`;/, 'the branch report.mjs pushes is not engine-bump/<tag>');
  assert.ok(!/refs\/tags|\/pulls|'main'|"main"/.test(report.replace(/^\s*\/\/.*$/gm, '')), 'report.mjs touches a tag, main or a pull request');
});
