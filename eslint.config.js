import stylistic from '@stylistic/eslint-plugin'
import js from '@eslint/js'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { flatConfigs as importXConfigs } from 'eslint-plugin-import-x'
import tseslint, { configs as tsConfigs } from 'typescript-eslint'

/**
 * Lint rules encoding the conventions in AGENTS.md, so the house style is enforced by the build
 * rather than remembered. Each block below cites the section of AGENTS.md it comes from.
 *
 * The existing codebase is the reference implementation of this style: every rule here is one the
 * code already satisfies, so a new violation is a real signal rather than pre-existing noise.
 */

/** AGENTS.md §2.1 — dependencies point inward. Each layer names what it may NOT reach for. */
const INWARD_ONLY = {
  domain: {
    patterns: [{ group: ['~/*'], message: 'domain/ is the centre: it imports nothing from other layers (AGENTS.md §2.1).' }],
  },
  pureLogic: {
    patterns: [
      {
        group: ['~/web/*', '~/cli/*', '~/jobs/*', '~/db/*', '~/app/*', '~/ingest/*', '~/auth/*', '~/audit/*'],
        message: 'match/, write/ and verify/ are pure logic: they may use domain and the icu port only (AGENTS.md §2.1).',
      },
      {
        group: ['~/icu/http-*', '~/icu/audited-*'],
        message: 'Depend on the IntervalsIcuClient port, never on an adapter that implements it (AGENTS.md §2.4).',
      },
    ],
  },
  app: {
    patterns: [
      {
        group: ['~/web/*', '~/cli/*', '~/jobs/*'],
        message: 'app/ holds use cases; driving adapters depend on it, not the other way round (AGENTS.md §2.1).',
      },
      {
        group: ['~/icu/http-*', '~/icu/audited-*'],
        message: 'Depend on the IntervalsIcuClient port, never on an adapter that implements it (AGENTS.md §2.4).',
      },
    ],
  },
  ingest: {
    patterns: [
      {
        group: ['~/web/*', '~/cli/*', '~/jobs/*', '~/app/*', '~/icu/*', '~/write/*', '~/verify/*', '~/match/*'],
        message: 'ingest/ converts to SprintSession at the edge; it must not know what happens downstream (AGENTS.md §2.3).',
      },
    ],
  },
}

/** AGENTS.md §2.5 — only the composition root and explicit factories read the environment. */
const READS_THE_ENVIRONMENT = [
  'src/config.ts',
  'src/cli/main.ts',
  'src/db/migrate-cli.ts',
  'src/security/reseal-cli.ts',
  'src/ingest/freelap-sources.ts',
  'src/security/local-kms.ts',
]

/** AGENTS.md §4.6 — CLI uses console for user-facing output; everything else uses the Logger port (O3 / #25). */
const WRITES_TO_THE_CONSOLE = ['src/cli/**']

export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**', '**/*.d.ts'] },

  js.configs.recommended,
  ...tsConfigs.strictTypeChecked,
  ...tsConfigs.stylisticTypeChecked,
  importXConfigs.recommended,
  importXConfigs.typescript,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: './tsconfig.json' })],
    },
    plugins: { '@stylistic': stylistic },

    rules: {
      // ── Formatting, as the codebase already writes it (AGENTS.md §4.3) ──────────────────────
      '@stylistic/semi': ['error', 'never'],
      // Backticks are deliberate here — SQL statements and HTML fragments read far better in a
      // template literal than in a single-quoted string full of `\'` escapes.
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      // Warn: 120 is the convention the code follows almost everywhere, but ~29 lines pre-date the
      // rule. Warning keeps them visible without failing the gate; reflow them and raise to error.
      '@stylistic/max-len': ['warn', { code: 120, ignoreUrls: true, ignoreRegExpLiterals: true }],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      '@stylistic/padding-line-between-statements': [
        'error',
        // A guard clause is followed by a blank line, so the happy path stands apart (§4.2).
        { blankLine: 'always', prev: 'block-like', next: 'return' },
      ],

      // ── Imports: named only, grouped node → ~/ → relative (AGENTS.md §4.3) ──────────────────
      'import-x/no-default-export': 'error',
      // Warn: the only cycles today are type-only (web routes import `RequestContext` back from
      // web-app.ts), erased at runtime. The rule cannot tell those from value cycles, so it stays a
      // warning until `RequestContext`/`WebAppDependencies` move to their own module — then error.
      'import-x/no-cycle': ['warn', { maxDepth: Infinity }],
      'import-x/no-useless-path-segments': ['error', { noUselessIndex: true }],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [{ pattern: '~/**', group: 'internal', position: 'before' }],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'ignore' },
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // ── Types: no escape hatches without a reason (AGENTS.md §4.3) ─────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as' }],
      // `readonly Rep[]` for simple elements, `ReadonlyArray<{ ... }>` for complex ones — which is
      // what the codebase already does, and keeps `readonly [string, string][]` off the page.
      '@typescript-eslint/array-type': ['error', { default: 'array-simple', readonly: 'array-simple' }],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // The ports are async by contract; an implementation that happens to be synchronous (an
      // in-memory ledger, a fake, a static route) still satisfies them. Requiring `await` in the
      // body would punish exactly the test doubles that keep the ports honest (AGENTS.md §2.4).
      '@typescript-eslint/require-await': 'off',
      // `void handle(...)`, `(line) => console.log(line)` and similar are deliberate here.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // 35 deliberate, proof-adjacent uses exist. "Proof on the line above" is not machine-checkable,
      // so this stays a review concern rather than a lint rule (AGENTS.md §4.3).
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/prefer-readonly': 'error',
      // `allowConstantLoopConditions`: the worker's `while (running)` is flipped by a SIGTERM
      // handler the analyzer cannot see, so without this the loop reads as always-true.
      '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: true }],
      // `query<JobRow>(...)`, `json<T>()` and `one<T>(...)` let the caller name the shape it expects
      // at the call site. The rule is right that it is a cast in a generic's clothing, but it is a
      // deliberate, pervasive part of the database and HTTP boundary API.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // Warn: `Response.formData()` is deprecated for server multipart parsing. Issue #5 rewrites
      // `readRequestBody` to cap body size and will replace it then.
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // ── Naming: intent, no I-prefix, no Impl suffix (AGENTS.md §4.1) ───────────────────────
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'], custom: { regex: '^I[A-Z]|Impl$', match: false } },
        { selector: 'variable', format: ['camelCase', 'PascalCase', 'UPPER_CASE'] },
        { selector: 'function', format: ['camelCase'] },
        { selector: 'classMethod', format: ['camelCase'] },
        { selector: 'typeProperty', format: null },
      ],

      // ── Functions: small, one level of abstraction, guard clauses (AGENTS.md §4.2) ──────────
      'no-else-return': ['error', { allowElseIf: false }],
      'max-depth': ['error', 3],
      // Exported APIs take an options object; private helpers stay positional and short. Warn, so
      // the one 5-parameter helper (csv-adapter's `readRow`) stays visible without failing the gate.
      'max-params': ['warn', 4],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 12],

      // ── Comments: why, not what; nothing parked for later (AGENTS.md §4.4) ─────────────────
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'anywhere' }],

      // ── Errors: nothing swallowed, nothing floating (AGENTS.md §4.5) ───────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],

      // ── Composition: time and configuration are dependencies (AGENTS.md §2.5) ──────────────
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration in src/config.ts and inject it (AGENTS.md §2.5).' },
      ],
      // Warn, not error: three pre-existing sites still call this in logic. See the report in
      // AGENTS.md §2.5 — the fix is to take `now: () => Date` and default it at the composition root.
      'no-restricted-syntax': [
        'warn',
        {
          // Only reading the clock *inline* — `new Date().toISOString()`. The prescribed pattern,
          // `options.now ?? (() => new Date())` and `now = new Date()` defaults, is left alone
          // because that is precisely how the dependency gets injected.
          selector: 'MemberExpression > NewExpression[callee.name="Date"][arguments.length=0]',
          message: 'Time is a dependency: take `now: () => Date` and default it at the composition root (AGENTS.md §2.5).',
        },
      ],

      // ── Housekeeping ────────────────────────────────────────────────────────────────────────
      'no-console': 'error',
      // The CSV reader strips a literal U+FEFF byte-order mark in a regex; that is data handling,
      // not a stray keystroke. (Worth writing as FEFF one day so it is visible on the page.)
      'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
      // `ignoreRestSiblings`: `const { sourceId, ...rest } = session` is how a field is omitted.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // `String(athlete.id)` coerces a field the live API has not been confirmed to send as a
      // string (issue #35). Removing the coercion because the *declared* type says string would
      // trade real robustness for a type we have not yet verified.
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
    },
  },

  // ── Architectural boundaries, layer by layer (AGENTS.md §2.1) ────────────────────────────────
  { files: ['src/domain/**/*.ts'], rules: { 'no-restricted-imports': ['error', INWARD_ONLY.domain] } },
  {
    files: ['src/match/**/*.ts', 'src/write/**/*.ts', 'src/verify/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', INWARD_ONLY.pureLogic] },
  },
  { files: ['src/app/**/*.ts'], rules: { 'no-restricted-imports': ['error', INWARD_ONLY.app] } },
  { files: ['src/ingest/**/*.ts'], rules: { 'no-restricted-imports': ['error', INWARD_ONLY.ingest] } },

  // `Applications` is the per-athlete composition root — building the icu client with that
  // athlete's refreshed credentials and audit trail is its whole job, so it may name the adapters.
  { files: ['src/app/applications.ts'], rules: { 'no-restricted-imports': 'off' } },

  // Route registrars are declarative tables, not logic: length is the point, not a smell.
  { files: ['src/web/routes/**/*.ts'], rules: { 'max-lines-per-function': 'off' } },

  // ── The few files allowed to touch the outside world directly ────────────────────────────────
  { files: READS_THE_ENVIRONMENT, rules: { 'no-restricted-properties': 'off' } },
  { files: WRITES_TO_THE_CONSOLE, rules: { 'no-console': 'off' } },

  // ── Tests: same style, different pressures (AGENTS.md §3.5) ──────────────────────────────────
  {
    files: ['test/**/*.ts'],
    rules: {
      // A test states only what matters to it; builders and fixtures make the rest explicit
      // elsewhere, so these limits fight the arrangement rather than helping it.
      'max-lines-per-function': 'off',
      complexity: 'off',
      'max-params': 'off',
      'max-depth': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
      // No-op callbacks and hand-narrowed payloads are how doubles and boundary tests are written.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // Doubles handle loosely-typed boundary values (`FormData.get` returns string | File) on
      // purpose; the production code they stand in for keeps the strict rules.
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },

  { files: ['*.config.ts', '*.config.js'], rules: { 'import-x/no-default-export': 'off' } },

  // The config files describe the toolchain and sit outside the tsconfig project.
  {
    files: ['eslint.config.js'],
    extends: [tsConfigs.disableTypeChecked],
    rules: { 'import-x/no-default-export': 'off', '@stylistic/max-len': 'off' },
  },
)
