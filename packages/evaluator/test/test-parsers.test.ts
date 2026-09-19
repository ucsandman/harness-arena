import { describe, expect, it } from 'vitest';
import { parseTestOutput } from '../src/index.js';

const VITEST_FAIL = `
 RUN  v5.0.1 C:/repo

 ✓ test/sum.test.ts (2 tests) 4ms
 ❯ test/math.test.ts (2 tests | 1 failed) 7ms
   × adds numbers 3ms
     → expected 3 to be 4

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)
   Start at  10:01:02
   Duration  512ms

 FAIL  test/math.test.ts > math > adds numbers
AssertionError: expected 3 to be 4
`;

const VITEST_PASS = `
 ✓ test/sum.test.ts (3 tests) 5ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  402ms
`;

const VITEST_SKIPPED = `
 Test Files  1 passed (1)
      Tests  2 passed | 1 skipped (3)
`;

const JEST_FAIL = `
 FAIL  src/math.test.js
  math
    ✕ adds numbers (3 ms)
    ✓ subtracts numbers (1 ms)

  ● math › adds numbers

    expect(received).toBe(expected)

    Expected: 4
    Received: 3

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total
Snapshots:   0 total
Time:        1.234 s
`;

const JEST_PASS = `
 PASS  src/math.test.js
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Time:        0.9 s
`;

const PYTEST_FAIL = `============================= test session starts =============================
platform win32 -- Python 3.12.3, pytest-8.3.2, pluggy-1.5.0
collected 4 items

tests/test_math.py ..F.                                                  [100%]

================================== FAILURES ===================================
__________________________________ test_adds __________________________________

    def test_adds():
>       assert add(1, 2) == 4
E       assert 3 == 4

=========================== short test summary info ===========================
FAILED tests/test_math.py::test_adds - assert 3 == 4
========================= 1 failed, 3 passed in 0.52s =========================
`;

const PYTEST_PASS = `============================= test session starts =============================
collected 4 items

tests/test_math.py ....                                                  [100%]

============================== 4 passed in 0.31s ==============================
`;

const GO_FAIL = `=== RUN   TestAdd
--- FAIL: TestAdd (0.00s)
    math_test.go:12: expected 4, got 3
=== RUN   TestSub
--- PASS: TestSub (0.00s)
=== RUN   TestMul
--- PASS: TestMul (0.00s)
FAIL
exit status 1
FAIL	example.com/calc	0.004s
`;

const GO_PACKAGE_ONLY = `ok  	example.com/calc	0.004s
FAIL	example.com/util	0.006s
FAIL
`;

const CARGO_FAIL = `
running 4 tests
test tests::subtracts ... ok
test tests::adds ... FAILED
test tests::divides ... ok
test tests::multiplies ... ok

failures:

---- tests::adds stdout ----
thread 'tests::adds' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed

failures:
    tests::adds

test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const CARGO_PASS = `
running 4 tests
test tests::adds ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;

const TAP_FAIL = `TAP version 13
# Subtest: adds numbers
not ok 1 - adds numbers
  ---
  duration_ms: 1.5
  location: 'test/math.test.js:4:1'
  ...
# Subtest: subtracts numbers
ok 2 - subtracts numbers
ok 3 - multiplies numbers
ok 4 - divides numbers # SKIP not implemented
1..4
# tests 4
# suites 1
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 120.5
`;

const TAP_PASS = `TAP version 13
ok 1 - adds numbers
1..1
# tests 1
# pass 1
# fail 0
`;

describe('parseTestOutput / vitest', () => {
  it('reads counts and failing names from a failing run', () => {
    const parsed = parseTestOutput(VITEST_FAIL, 'vitest');
    expect(parsed).toMatchObject({ passed: 3, failed: 1, skipped: 0, total: 4, parser: 'vitest' });
    expect(parsed.failingTests).toContain('test/math.test.ts > math > adds numbers');
    expect(parsed.failingTests).toContain('adds numbers');
  });

  it('reads a passing run', () => {
    expect(parseTestOutput(VITEST_PASS, 'vitest')).toMatchObject({
      passed: 3,
      failed: 0,
      total: 3,
      failingTests: [],
    });
  });

  it('counts skipped tests', () => {
    expect(parseTestOutput(VITEST_SKIPPED, 'vitest')).toMatchObject({ passed: 2, skipped: 1, total: 3 });
  });

  it('does not confuse the "Test Files" line with the "Tests" line', () => {
    expect(parseTestOutput(' Test Files  1 failed (1)\n', 'vitest')).toMatchObject({
      passed: null,
      total: null,
      parser: 'vitest',
    });
  });
});

describe('parseTestOutput / jest', () => {
  it('reads counts and the failing bullet lines', () => {
    const parsed = parseTestOutput(JEST_FAIL, 'jest');
    expect(parsed).toMatchObject({ passed: 3, failed: 1, total: 4, parser: 'jest' });
    expect(parsed.failingTests).toEqual(['math › adds numbers']);
  });

  it('reads a passing run', () => {
    expect(parseTestOutput(JEST_PASS, 'jest')).toMatchObject({ passed: 4, failed: 0, total: 4 });
  });
});

describe('parseTestOutput / pytest', () => {
  it('reads the summary line and FAILED node ids', () => {
    const parsed = parseTestOutput(PYTEST_FAIL, 'pytest');
    expect(parsed).toMatchObject({ passed: 3, failed: 1, total: 4, parser: 'pytest' });
    expect(parsed.failingTests).toEqual(['tests/test_math.py::test_adds']);
  });

  it('reads a passing run and ignores the session header', () => {
    expect(parseTestOutput(PYTEST_PASS, 'pytest')).toMatchObject({ passed: 4, failed: 0, total: 4 });
  });
});

describe('parseTestOutput / go', () => {
  it('counts --- PASS / --- FAIL lines', () => {
    const parsed = parseTestOutput(GO_FAIL, 'go');
    expect(parsed).toMatchObject({ passed: 2, failed: 1, total: 3, parser: 'go' });
    expect(parsed.failingTests).toEqual(['TestAdd']);
  });

  it('falls back to per-package ok/FAIL lines', () => {
    const parsed = parseTestOutput(GO_PACKAGE_ONLY, 'go');
    expect(parsed).toMatchObject({ passed: 1, failed: 1, total: 2 });
    expect(parsed.failingTests).toEqual(['example.com/util']);
  });

  it('does not read TAP ok lines as go packages', () => {
    expect(parseTestOutput(TAP_FAIL, 'go')).toMatchObject({ passed: null, total: null, parser: 'go' });
  });
});

describe('parseTestOutput / cargo', () => {
  it('reads the test result line and FAILED test names', () => {
    const parsed = parseTestOutput(CARGO_FAIL, 'cargo');
    expect(parsed).toMatchObject({ passed: 3, failed: 1, skipped: 0, total: 4, parser: 'cargo' });
    expect(parsed.failingTests).toEqual(['tests::adds']);
  });

  it('reads a passing run', () => {
    expect(parseTestOutput(CARGO_PASS, 'cargo')).toMatchObject({ passed: 4, failed: 0, total: 4 });
  });
});

describe('parseTestOutput / tap', () => {
  it('reads # pass / # fail and not ok names, skipping directives', () => {
    const parsed = parseTestOutput(TAP_FAIL, 'tap');
    expect(parsed).toMatchObject({ passed: 3, failed: 1, total: 4, parser: 'tap' });
    expect(parsed.failingTests).toEqual(['adds numbers']);
  });

  it('reads a passing run', () => {
    expect(parseTestOutput(TAP_PASS, 'tap')).toMatchObject({ passed: 1, failed: 0, total: 1 });
  });
});

describe('parseTestOutput / exit-code and auto', () => {
  it('exit-code reports no counts at all', () => {
    expect(parseTestOutput(VITEST_FAIL, 'exit-code')).toEqual({
      passed: null,
      failed: null,
      skipped: null,
      total: null,
      failingTests: [],
      parser: 'exit-code',
    });
  });

  it('auto picks the right parser for every tool', () => {
    const cases: Array<[string, string]> = [
      [VITEST_FAIL, 'vitest'],
      [JEST_FAIL, 'jest'],
      [PYTEST_FAIL, 'pytest'],
      [GO_FAIL, 'go'],
      [GO_PACKAGE_ONLY, 'go'],
      [CARGO_FAIL, 'cargo'],
      [TAP_FAIL, 'tap'],
    ];
    for (const [output, expected] of cases) {
      expect(parseTestOutput(output, 'auto').parser, `auto for ${expected}`).toBe(expected);
    }
  });

  it('auto falls back to exit-code on output it cannot read', () => {
    expect(parseTestOutput('make: *** [test] Error 2\n', 'auto')).toMatchObject({
      parser: 'exit-code',
      passed: null,
      failed: null,
    });
  });

  it('an explicit parser that does not match reports its own name with null counts', () => {
    expect(parseTestOutput(VITEST_FAIL, 'pytest')).toMatchObject({
      parser: 'pytest',
      passed: null,
      total: null,
    });
  });
});
