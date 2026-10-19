import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommandExamples } from '../../tools/lib/doc-command-examples.mjs';
import { parseCommandArguments } from '../../packages/cli/src/command-registry.js';

function shell(body: string, language = 'sh', fence = '```'): string {
  return `# Examples\n\n${fence}${language}\n${body}\n${fence}\n`;
}

void test('pure parser validates commands, strict flags, conditional and required arguments', () => {
  const args = ['project', 'init', '--path', '/private/new project'];
  const parsed = parseCommandArguments(args);
  assert.deepEqual(parsed.positionals, ['project', 'init']);
  assert.equal(parsed.values['path'], '/private/new project');
  assert.deepEqual(args, ['project', 'init', '--path', '/private/new project']);
  for (const argv of [
    ['unknown'],
    ['host', 'doctor', '--bad'],
    ['host', 'doctor', '--yes'],
    ['project', 'init'],
    ['project', 'init', '--path', ''],
    ['host', 'doctor', '--image', 'image'],
    ['device', 'recover', '--asset', 'phone', '--inspected'],
    ['device', 'inspect', '--execution', 'docker'],
  ])
    assert.throws(() => parseCommandArguments(argv));
  assert.doesNotThrow(() => parseCommandArguments(['project', 'init', '--help']));
});

void test('all shell fence styles and concrete launchers share registry validation', () => {
  for (const language of ['sh', 'bash', 'shell', 'console']) {
    for (const fence of ['```', '~~~~']) {
      const errors = checkCommandExamples(
        shell(
          [
            'pxv host doctor --yes',
            'pnpm pxv unknown',
            'node ./packages/cli/dist/main.js project init',
            '/usr/bin/node /checkout/packages/cli/dist/main.js host doctor --image wrong',
          ].join('\n'),
          language,
          fence,
        ),
        'guide.md',
      );
      assert.equal(errors.length, 4);
      assert.match(errors[0] ?? '', /^guide\.md:4:17: --yes is not supported/u);
      assert.match(errors[1] ?? '', /^guide\.md:5:1: Unknown command/u);
      assert.match(errors[2] ?? '', /--path is required/u);
    }
  }
  assert.deepEqual(checkCommandExamples(shell('pxv unknown', 'text'), 'guide.md'), []);
});

void test('quotes, empty arguments, escapes, comments, prompts and continuations retain locations', () => {
  assert.deepEqual(
    checkCommandExamples(
      shell(
        [
          '# pxv unknown is a comment',
          'pxv project init --path "a path" # pxv unknown',
          "pxv project init --path 'single quoted'",
          'pxv project init --path escaped\\ path',
          '$ pxv project init \\',
          '  --path /new/project',
          'pxv project init --path "a\\$literal"',
          'pxv project init --path "a\\q"',
        ].join('\n'),
      ),
      'guide.md',
    ),
    [],
  );
  const errors = checkCommandExamples(shell('$ pxv project init \\\n  --path ""'), 'guide.md');
  assert.deepEqual(errors, ['guide.md:5:3: --path is required']);
  const quotes = checkCommandExamples(shell('pxv project init --path "unfinished'), 'guide.md');
  assert.match(quotes[0] ?? '', /guide\.md:4:25: Unterminated shell quote/u);
  assert.deepEqual(checkCommandExamples(shell('# pxv version\n> pxv host doctor', 'console'), 'g.md'), []);
});

void test('variables and substitution are opaque, and shell redirections/pipelines are not argv', () => {
  const valid = [
    'PXV_ROOT=/private X="some value" pxv project init --path "$ROOT"',
    'pxv project init --path "${ROOT:-/private/path}"',
    'pxv project init --path "$(printf \'a path\')"',
    'pxv project init --path `printf /private/path`',
    'pxv host doctor > report.json 2>&1 | cat',
    '< input.json pxv version >> output.json',
    'echo content | pnpm pxv version && pxv host doctor; pxv help &',
  ];
  assert.deepEqual(checkCommandExamples(shell(valid.join('\n')), 'guide.md'), []);
  const errors = checkCommandExamples(
    shell('echo hi | pxv unknown >out\npxv version && pxv host doctor --yes'),
    'g.md',
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? '', /^g.md:4:11:/u);
  assert.match(errors[1] ?? '', /^g.md:5:32:/u);
});

void test('heredocs and dynamic wrappers do not become fictitious commands', () => {
  const text = [
    "cat <<'EOF'",
    'pxv unknown',
    'EOF',
    'pxv host doctor <<-END',
    '\tpxv unknown',
    '\tEND',
    'cat <<ONE <<TWO',
    'pxv unknown',
    'ONE',
    'pxv unknown',
    'TWO',
    'env pxv unknown',
    '"$LAUNCHER" pxv unknown',
    'sh -c "pxv unknown"',
    'echo "$(pxv unknown)"',
    'pxv version',
  ].join('\n');
  assert.deepEqual(checkCommandExamples(shell(text), 'guide.md'), []);
});

void test('only true argument forwarding skips a segment; ordinary variable values stay opaque', () => {
  for (const forwarding of ['"$@"', '"$*"', '"${@}"', '"${*}"']) {
    const wrappers = [
      `node ./packages/cli/dist/main.js ${forwarding}`,
      `pxv() { node ./packages/cli/dist/main.js ${forwarding}; }`,
      `pxv ${forwarding}`,
    ];
    assert.deepEqual(checkCommandExamples(shell(wrappers.join('\n')), 'guide.md'), []);
  }
  const errors = checkCommandExamples(
    shell(
      [
        'pxv project init --path "$PATH_VALUE" --yes',
        "pxv project init --path '$@' --yes",
        'pxv project init --path "\\$@" --yes',
        'pxv host doctor --image "$IMAGE"',
        'node ./packages/cli/dist/main.js "$@"; pxv unknown',
      ].join('\n'),
    ),
    'guide.md',
  );
  assert.equal(errors.length, 5);
  assert.match(errors[0] ?? '', /--yes is not supported/u);
  assert.match(errors[3] ?? '', /--image is not supported/u);
  assert.match(errors[4] ?? '', /Unknown command/u);
});

void test('substitution is never executed or allowed to hide later diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pxv-doc-static-'));
  const marker = join(directory, 'never-created');
  try {
    const errors = checkCommandExamples(
      shell(
        [
          `pxv project init --path "$(touch '${marker}'; echo $(pxv unknown))"`,
          `pxv project init --path \`touch '${marker}'\``,
          'pxv host doctor --yes',
          'pnpm pxv project init --path ""',
        ].join('\n'),
      ),
      'guide.md',
    );
    assert.equal(errors.length, 2);
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
