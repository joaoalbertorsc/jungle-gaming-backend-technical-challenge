/**
 * CI guard against a "false green": fails when a test is focused (.only) or skipped
 * (.skip / .skipIf / .if / .todoIf), since those let a suite pass without running everything.
 */
export {};

const FORBIDDEN = /\b(?:describe|test|it)\s*\.\s*(?:only|skip|skipIf|if|todoIf)\b/;

const violations: string[] = [];
for await (const file of new Bun.Glob('test/**/*.ts').scan('.')) {
  const lines = (await Bun.file(file).text()).split('\n');
  lines.forEach((line, index) => {
    if (FORBIDDEN.test(line)) violations.push(`${file}:${String(index + 1)}  ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(`Focused or skipped tests found:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('No focused or skipped tests.');
