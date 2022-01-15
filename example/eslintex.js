const { ESLint } = require("eslint");

(async function main() {
  // 1. Create an instance with the `fix` option.
  const eslint = new ESLint({ fix: true });

  // 2. Lint files. This doesn't modify target files.
  // const results = await eslint.lintFiles(['**/*.js']);
  const results = await eslint.lintText(
    "(async () => {\n" +
      "    const fileA = await promisedfsreadFile(path.join(__dirname, 'mock/1.txt'), 'utf8');;\n" +
      "    const fileB = await promisedfsreadFile(path.join(__dirname, 'mock/2.txt'), 'utf8');;\n" +
      "    const result = await promisedsortFileContents(fileA, fileB);;\n" +
      "    (result.join('\\n'))\n" +
      "})();"
  );

  // const results = await eslint.lintText('const a = "b";;;');

  // console.log(results);
  console.log(results[0].output);

  // // 3. Modify the files with the fixed code.
  await ESLint.outputFixes(results);
  //
  // // 4. Format the results.
  const formatter = await eslint.loadFormatter("stylish");
  const resultText = formatter.format(results);
  //
  // // 5. Output it.
  // console.log(resultText);
})().catch((error) => {
  process.exitCode = 1;
  console.error(error);
});
